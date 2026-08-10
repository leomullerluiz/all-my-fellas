import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * S3/S4 — the archive/unarchive routes (single task and batch) and S7's
 * batch-cancel counterpart. Follows the fixture pattern in
 * `tests/api-tasks-batch-start.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-tasks-archive-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let archiveRoute: typeof import("@/app/api/tasks/[id]/archive/route");
let unarchiveRoute: typeof import("@/app/api/tasks/[id]/unarchive/route");
let batchArchiveRoute: typeof import("@/app/api/tasks/batch-archive/route");
let batchCancelRoute: typeof import("@/app/api/tasks/batch-cancel/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  orchestrator = await import("@/server/pipeline/orchestrator");
  archiveRoute = await import("@/app/api/tasks/[id]/archive/route");
  unarchiveRoute = await import("@/app/api/tasks/[id]/unarchive/route");
  batchArchiveRoute = await import("@/app/api/tasks/batch-archive/route");
  batchCancelRoute = await import("@/app/api/tasks/batch-cancel/route");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const task of service.listTasks({ includeArchived: true })) service.deleteTask(task.id);
  settings.updateSettings({ maxParallelTasks: 5 });
});

function seed(title = "A task") {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/tasks/:id/archive and /unarchive", () => {
  it("archives then unarchives a task", async () => {
    const task = seed();

    const archived = await archiveRoute.POST(new Request("http://test"), params(task.id));
    expect(archived.status).toBe(200);
    expect(service.getTask(task.id)!.archivedAt).not.toBeNull();

    const unarchived = await unarchiveRoute.POST(new Request("http://test"), params(task.id));
    expect(unarchived.status).toBe(200);
    expect(service.getTask(task.id)!.archivedAt).toBeNull();
  });

  it("404s for an unknown task", async () => {
    const response = await archiveRoute.POST(new Request("http://test"), params("task_missing"));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/tasks/batch-archive", () => {
  it("archives every selected task and reports an already-archived one distinctly", async () => {
    const a = seed("A");
    const b = seed("B");
    service.archiveTask(b.id);

    const response = await batchArchiveRoute.POST(
      new Request("http://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [a.id, b.id] }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      results: Array<{ taskId: string; archived: boolean; reason: string | null }>;
    };
    const resultA = payload.results.find((r) => r.taskId === a.id)!;
    expect(resultA.archived).toBe(true);
    const resultB = payload.results.find((r) => r.taskId === b.id)!;
    expect(resultB.archived).toBe(false);
    expect(resultB.reason).toBe("Already archived.");

    expect(service.getTask(a.id)!.archivedAt).not.toBeNull();
  });
});

describe("POST /api/tasks/batch-cancel", () => {
  it("cancels a running task and reports an already-finished one distinctly", async () => {
    const running = seed("Running");
    orchestrator.startTask(running.id);
    const finished = seed("Finished");
    service.setTaskStage(finished.id, "COMPLETED");

    const response = await batchCancelRoute.POST(
      new Request("http://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [running.id, finished.id] }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      results: Array<{ taskId: string; cancelled: boolean; reason: string | null }>;
    };
    const resultRunning = payload.results.find((r) => r.taskId === running.id)!;
    expect(resultRunning.cancelled).toBe(true);
    expect(service.getTask(running.id)!.status).toBe("cancelled");

    const resultFinished = payload.results.find((r) => r.taskId === finished.id)!;
    expect(resultFinished.cancelled).toBe(false);
    expect(resultFinished.reason).toBe("Already finished.");
  });
});
