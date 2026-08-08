import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Transcript retention — S6 / spec-audit-trail.md §11.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-sweep-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let db: typeof import("@/server/db/client")["db"];
let schema: typeof import("@/server/db/schema");
let settingsStore: typeof import("@/server/settings/store");
let retention: typeof import("@/server/pipeline/audit/retention");
let transcriptRoute: typeof import("@/app/api/tasks/[id]/runs/[runId]/transcript/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  ({ db } = await import("@/server/db/client"));
  schema = await import("@/server/db/schema");
  settingsStore = await import("@/server/settings/store");
  retention = await import("@/server/pipeline/audit/retention");
  transcriptRoute = await import("@/app/api/tasks/[id]/runs/[runId]/transcript/route");

  repoId = service.createRepo({
    name: "acme/retention-sweep",
    url: "https://github.com/acme/retention-sweep",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function getAgentRun(id: string) {
  return db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get()!;
}

function newRunWithTranscript(createdAt: number) {
  const task = service.createTask({
    repoId,
    title: "Retention task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
  service.updateStageRun(run.id, {
    systemPrompt: "system prompt text",
    userPrompt: "user prompt text",
    model: "claude-sonnet-5",
    provider: "claude",
  });

  const agentId = `agent_${Math.random().toString(36).slice(2)}`;
  db.insert(schema.agentRuns)
    .values({
      id: agentId,
      stageRunId: run.id,
      sessionId: "sess_1",
      transcriptJson: JSON.stringify([{ type: "result", subtype: "success", result: "ok" }]),
      createdAt,
    })
    .run();

  return { task, run, agentId };
}

describe("sweepTranscriptRetention", () => {
  it("tombstones a row older than the cutoff and leaves a newer one untouched", () => {
    const now = Date.now();
    const { agentId: oldId } = newRunWithTranscript(now - 10 * 86_400_000);
    const { agentId: newId } = newRunWithTranscript(now - 1 * 86_400_000);

    const swept = service.sweepTranscriptRetention(now - 7 * 86_400_000);
    expect(swept).toBeGreaterThanOrEqual(1);

    const old = getAgentRun(oldId);
    const fresh = getAgentRun(newId);

    expect(JSON.parse(old.transcriptJson)).toMatchObject({ pruned: true });
    expect(JSON.parse(fresh.transcriptJson)).not.toMatchObject({ pruned: true });
  });

  it("is idempotent: running twice does not corrupt an already-tombstoned row", () => {
    const now = Date.now();
    const { agentId } = newRunWithTranscript(now - 30 * 86_400_000);
    const cutoff = now - 7 * 86_400_000;

    service.sweepTranscriptRetention(cutoff);
    const once = getAgentRun(agentId);

    service.sweepTranscriptRetention(cutoff);
    const twice = getAgentRun(agentId);

    expect(JSON.parse(twice.transcriptJson)).toMatchObject({ pruned: true });
    // A second sweep may refresh `prunedAt`, but must not otherwise mangle
    // the tombstone shape — both parse to the same well-formed object.
    expect(JSON.parse(twice.transcriptJson).pruned).toBe(JSON.parse(once.transcriptJson).pruned);
  });

  it("never touches the stage_runs prompt columns", () => {
    const now = Date.now();
    const { run } = newRunWithTranscript(now - 30 * 86_400_000);

    service.sweepTranscriptRetention(now - 7 * 86_400_000);

    const after = service.getStageRun(run.id)!;
    expect(after.systemPrompt).toBe("system prompt text");
    expect(after.userPrompt).toBe("user prompt text");
  });

  it("leaves the transcript route reporting a distinct pruned state", async () => {
    const now = Date.now();
    const { task, run } = newRunWithTranscript(now - 30 * 86_400_000);

    service.sweepTranscriptRetention(now - 7 * 86_400_000);

    const response = await transcriptRoute.GET(
      new Request(`http://localhost/api/tasks/${task.id}/runs/${run.id}/transcript`),
      { params: Promise.resolve({ id: task.id, runId: run.id }) },
    );
    const body = await response.json();

    expect(body.transcript.available).toBe(false);
    expect(body.transcript.reason).toBe("pruned");
    expect(typeof body.transcript.prunedAt).toBe("number");
  });
});

describe("runMaintenanceSweep", () => {
  it("is a no-op when transcriptRetentionDays is null (the default)", () => {
    settingsStore.updateSettings({ transcriptRetentionDays: null });
    const { agentId } = newRunWithTranscript(Date.now() - 365 * 86_400_000);

    const { swept } = retention.runMaintenanceSweep();
    expect(swept).toBe(0);

    const row = getAgentRun(agentId);
    expect(JSON.parse(row.transcriptJson)).not.toMatchObject({ pruned: true });
  });

  it("sweeps rows older than the configured number of days", () => {
    settingsStore.updateSettings({ transcriptRetentionDays: 7 });
    const { agentId } = newRunWithTranscript(Date.now() - 30 * 86_400_000);

    const { swept } = retention.runMaintenanceSweep();
    expect(swept).toBeGreaterThanOrEqual(1);

    const row = getAgentRun(agentId);
    expect(JSON.parse(row.transcriptJson)).toMatchObject({ pruned: true });

    settingsStore.updateSettings({ transcriptRetentionDays: null });
  });
});

describe("transcriptStorageStats", () => {
  it("reports count and total bytes across agent_runs", () => {
    newRunWithTranscript(Date.now());
    const stats = service.transcriptStorageStats();
    expect(stats.count).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});
