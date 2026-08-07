import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `GET /api/tasks/:taskId/runs/:runId/transcript` — S3.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-transcript-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let transcriptRoute: typeof import("@/app/api/tasks/[id]/runs/[runId]/transcript/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  orchestrator = await import("@/server/pipeline/orchestrator");
  transcriptRoute = await import("@/app/api/tasks/[id]/runs/[runId]/transcript/route");

  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });

  repoId = service.createRepo({
    name: "acme/api-transcript",
    url: "https://github.com/acme/api-transcript",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newRunWithTranscript(entryCount: number) {
  const task = service.createTask({
    repoId,
    title: "Transcript task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  orchestrator.startTask(task.id);
  const run = service.listStageRuns(task.id).find((candidate) => candidate.stage === "STAKEHOLDER_REFINEMENT")!;

  service.updateStageRun(run.id, {
    systemPrompt: "You are the Stakeholder. TOKEN=abcdef0123456789",
    userPrompt: "## Task\n\nDo the thing.",
    model: "claude-sonnet-5",
    provider: "claude",
  });

  const entries = Array.from({ length: entryCount }, (_, index) => ({
    type: "assistant",
    message: { content: [{ type: "text", text: `entry ${index}` }] },
  }));
  service.saveTranscript({ stageRunId: run.id, sessionId: "sess_abc", transcript: entries });

  return { task, run };
}

describe("GET /api/tasks/:id/runs/:runId/transcript", () => {
  it("returns the stage run, prompt (redacted) and a paginated transcript", async () => {
    const { task, run } = newRunWithTranscript(3);

    const request = new Request(`http://localhost/api/tasks/${task.id}/runs/${run.id}/transcript?offset=0&limit=2`);
    const response = await transcriptRoute.GET(request, {
      params: Promise.resolve({ id: task.id, runId: run.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stageRun.provider).toBe("claude");
    expect(body.prompt.system).toContain("TOKEN=[redacted:");
    expect(body.prompt.system).not.toContain("abcdef0123456789");
    expect(body.transcript.available).toBe(true);
    expect(body.transcript.total).toBe(3);
    expect(body.transcript.offset).toBe(0);
    expect(body.transcript.limit).toBe(2);
    expect(body.transcript.entries).toHaveLength(2);
    expect(body.transcript.provider).toBe("claude");
  });

  it("returns 404 for a runId that belongs to a different task", async () => {
    const { run: foreignRun } = newRunWithTranscript(1);
    const { task: otherTask } = newRunWithTranscript(1);

    const request = new Request(
      `http://localhost/api/tasks/${otherTask.id}/runs/${foreignRun.id}/transcript`,
    );
    const response = await transcriptRoute.GET(request, {
      params: Promise.resolve({ id: otherTask.id, runId: foreignRun.id }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown runId", async () => {
    const { task } = newRunWithTranscript(1);

    const request = new Request(`http://localhost/api/tasks/${task.id}/runs/run_nonexistent/transcript`);
    const response = await transcriptRoute.GET(request, {
      params: Promise.resolve({ id: task.id, runId: "run_nonexistent" }),
    });

    expect(response.status).toBe(404);
  });

  it("reports available: false with no crash for a run that never had a transcript", async () => {
    const task = service.createTask({
      repoId,
      title: "No transcript task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    const run = service.createStageRun({ taskId: task.id, stage: "DELIVERY", attempt: 1 });

    const request = new Request(`http://localhost/api/tasks/${task.id}/runs/${run.id}/transcript`);
    const response = await transcriptRoute.GET(request, {
      params: Promise.resolve({ id: task.id, runId: run.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.transcript.available).toBe(false);
  });
});
