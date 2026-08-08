import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `GET /api/tasks/:id/export` — S5 / spec-audit-trail.md §9.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-export-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let db: typeof import("@/server/db/client")["db"];
let schema: typeof import("@/server/db/schema");
let exportRoute: typeof import("@/app/api/tasks/[id]/export/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  ({ db } = await import("@/server/db/client"));
  schema = await import("@/server/db/schema");
  exportRoute = await import("@/app/api/tasks/[id]/export/route");

  repoId = service.createRepo({
    name: "acme/audit-export",
    url: "https://github.com/acme/audit-export",
    defaultBranch: "main",
    credentialRef: "AUDIT_EXPORT_TOKEN",
    credentialUsername: "svc-bot",
    apiBaseUrl: "https://git.internal.example.com",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newTaskWithReworkedDevReport() {
  const task = service.createTask({
    repoId,
    title: "Export task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });

  const devReport = ["## Summary", "", "x", "", "## Changes", "", "x", "", "## Commands Run", "", "x", "", "## Follow-ups", "", "None."].join("\n");

  for (const attempt of [1, 2, 3]) {
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt });
    service.markStageRunStatus(run.id, "done");
    service.saveArtifact({ taskId: task.id, stageRunId: run.id, type: "dev_report", contentMd: devReport });
  }

  return task;
}

async function getExport(taskId: string, query = "") {
  const request = new Request(`http://localhost/api/tasks/${taskId}/export${query}`);
  return exportRoute.GET(request, { params: Promise.resolve({ id: taskId }) });
}

describe("GET /api/tasks/:id/export", () => {
  it("sets the download filename and returns the top-level record shape", async () => {
    const task = newTaskWithReworkedDevReport();

    const response = await getExport(task.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="task-${task.id}.json"`,
    );

    const body = await response.json();
    expect(body.format).toBe("all-my-fellas/task-record");
    expect(body.version).toBe(1);
    expect(typeof body.exportedAt).toBe("number");
    expect(body.redaction).toMatchObject({ applied: true });
    expect(body.task.id).toBe(task.id);
    expect(body.repo).toMatchObject({ name: "acme/audit-export", provider: "github", defaultBranch: "main" });
    expect(Array.isArray(body.stageRuns)).toBe(true);
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(Array.isArray(body.dependsOn)).toBe(true);
    expect(Array.isArray(body.approvals)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.attachments)).toBe(true);
  });

  it("includes every artifact version, more than listLatestArtifacts returns", async () => {
    const task = newTaskWithReworkedDevReport();

    const response = await getExport(task.id);
    const body = await response.json();

    const devReportVersions = body.artifacts.filter((artifact: { type: string }) => artifact.type === "dev_report");
    expect(devReportVersions.length).toBe(3);
    expect(new Set(devReportVersions.map((a: { attempt: number }) => a.attempt))).toEqual(new Set([1, 2, 3]));

    const latest = service.listLatestArtifacts(task.id);
    expect(devReportVersions.length).toBeGreaterThan(latest.filter((a) => a.type === "dev_report").length);
  });

  it("omits attachment bytes, credentialRef, credentialUsername and apiBaseUrl", async () => {
    const task = newTaskWithReworkedDevReport();
    service.insertAttachments(task.id, [
      { filename: "notes.txt", mimeType: "text/plain", size: 5, buffer: Buffer.from("hello") },
    ]);

    const response = await getExport(task.id);
    const raw = await response.text();

    expect(raw).not.toContain("credentialRef");
    expect(raw).not.toContain("credentialUsername");
    expect(raw).not.toContain("apiBaseUrl");
    expect(raw).not.toContain("AUDIT_EXPORT_TOKEN");
    expect(raw).not.toContain("aGVsbG8="); // base64 of "hello" — bytes must not leak in

    const body = JSON.parse(raw);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({ filename: "notes.txt", sizeBytes: 5 });
    expect(body.attachments[0].downloadPath).toBe(`/api/tasks/${task.id}/attachments/${body.attachments[0].id}`);
    expect(body.attachments[0].data).toBeUndefined();
  });

  it("?transcripts=0 omits transcript entries but keeps the prompt", async () => {
    const task = service.createTask({
      repoId,
      title: "Export transcripts=0 task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.updateStageRun(run.id, {
      systemPrompt: "System prompt text",
      userPrompt: "User prompt text",
      model: "claude-sonnet-5",
      provider: "claude",
    });
    service.saveTranscript({
      stageRunId: run.id,
      sessionId: "sess_1",
      transcript: [{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }],
    });

    const withTranscripts = await (await getExport(task.id)).json();
    const run0 = withTranscripts.stageRuns.find((r: { id: string }) => r.id === run.id);
    expect(run0.transcript).toBeDefined();
    expect(run0.transcript.entries.length).toBeGreaterThan(0);
    expect(run0.prompt.system).toBe("System prompt text");

    const withoutTranscripts = await (await getExport(task.id, "?transcripts=0")).json();
    const run1 = withoutTranscripts.stageRuns.find((r: { id: string }) => r.id === run.id);
    expect(run1.transcript).toBeUndefined();
    expect(run1.prompt.system).toBe("System prompt text");
    expect(run1.prompt.user).toBe("User prompt text");
  });

  it("reports redaction.hits >= 1 for a task with a known secret in its transcript", async () => {
    const task = service.createTask({
      repoId,
      title: "Export with secret task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.updateStageRun(run.id, { model: "claude-sonnet-5", provider: "claude" });

    // Bypasses `saveTranscript`'s write-time redaction, simulating a row
    // written before S2 existed — read-time redaction (§10.1 layer 3) is
    // what this test exercises.
    db.insert(schema.agentRuns)
      .values({
        id: "agent_unredacted",
        stageRunId: run.id,
        sessionId: "sess_secret",
        transcriptJson: JSON.stringify([
          {
            type: "assistant",
            message: { content: [{ type: "text", text: `Found a leaked token: ghp_${"a".repeat(36)}` }] },
          },
        ]),
      })
      .run();

    const body = await (await getExport(task.id)).json();
    expect(body.redaction.hits).toBeGreaterThanOrEqual(1);

    const run0 = body.stageRuns.find((r: { id: string }) => r.id === run.id);
    const textEntry = run0.transcript.entries.find((entry: { text?: string }) => entry.text?.includes("redacted"));
    expect(textEntry).toBeDefined();
    expect(JSON.stringify(run0)).not.toContain("ghp_" + "a".repeat(36));
  });

  it("reports redaction.hits: 0 for a task with no secrets", async () => {
    const task = newTaskWithReworkedDevReport();

    const body = await (await getExport(task.id)).json();
    expect(body.redaction.hits).toBe(0);
  });

  it("returns 404 for an unknown task", async () => {
    const response = await getExport("task_missing");
    expect(response.status).toBe(404);
  });

  it("has no corresponding import route", () => {
    const importDir = path.resolve(process.cwd(), "src/app/api/tasks/[id]/import");
    expect(fs.existsSync(importDir)).toBe(false);
    expect((exportRoute as { POST?: unknown }).POST).toBeUndefined();
  });
});
