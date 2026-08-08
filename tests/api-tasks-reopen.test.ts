import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `POST /api/tasks/:id/reopen` — moves a Not-delivered task (`REJECTED`,
 * `FAILED`, or `CANCELLED`) back to `CREATED`. Follows the fixture pattern in
 * `tests/api-tasks-gates.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-reopen-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let reopenRoute: typeof import("@/app/api/tasks/[id]/reopen/route");
let taskRoute: typeof import("@/app/api/tasks/[id]/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  orchestrator = await import("@/server/pipeline/orchestrator");
  reopenRoute = await import("@/app/api/tasks/[id]/reopen/route");
  taskRoute = await import("@/app/api/tasks/[id]/route");

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
  for (const task of service.listTasks()) service.deleteTask(task.id);
  settings.updateSettings({ maxParallelTasks: 5 });
});

function create(title: string, overrides: Partial<Parameters<typeof service.createTask>[0]> = {}) {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
    ...overrides,
  });
}

function reopen(taskId: string) {
  return reopenRoute.POST(new Request(`http://test/api/tasks/${taskId}/reopen`, { method: "POST" }), {
    params: Promise.resolve({ id: taskId }),
  });
}

async function getTaskDetail(taskId: string) {
  const response = await taskRoute.GET(new Request("http://test"), {
    params: Promise.resolve({ id: taskId }),
  });
  return (await response.json()) as {
    task: {
      status: string;
      currentStage: string;
      title: string;
      description: string;
      repoId: string;
      priority: string;
      difficulty: string | null;
      criticality: string | null;
    };
    dependsOn: Array<{ id: string }>;
  };
}

describe("POST /api/tasks/:id/reopen", () => {
  it.each(["REJECTED", "FAILED", "CANCELLED"] as const)(
    "moves a %s task to CREATED/queued",
    async (stage) => {
      const task = create(`Closed as ${stage}`);
      service.setTaskStage(task.id, stage);

      const response = await reopen(task.id);
      expect(response.status).toBe(200);

      const body = await getTaskDetail(task.id);
      expect(body.task.currentStage).toBe("CREATED");
      expect(body.task.status).toBe("queued");
    },
  );

  it("preserves title, description, repo, priority, difficulty, criticality, and dependsOn", async () => {
    const prereq = create("Prerequisite");
    const task = create("Preserve me", { dependsOn: [prereq.id] });
    service.setTaskEstimate(task.id, "M", "high");
    service.setTaskStage(task.id, "FAILED");

    const before = await getTaskDetail(task.id);

    await reopen(task.id);

    const after = await getTaskDetail(task.id);
    expect(after.task.title).toBe(before.task.title);
    expect(after.task.description).toBe(before.task.description);
    expect(after.task.repoId).toBe(before.task.repoId);
    expect(after.task.priority).toBe(before.task.priority);
    expect(after.task.difficulty).toBe(before.task.difficulty);
    expect(after.task.criticality).toBe(before.task.criticality);
    expect(after.dependsOn.map((d) => d.id)).toEqual(before.dependsOn.map((d) => d.id));
  });

  it("makes the moved task eligible for the ordinary CREATED start path", async () => {
    const task = create("Retry me");
    service.setTaskStage(task.id, "CANCELLED");

    await reopen(task.id);

    // `startTask` only accepts CREATED tasks; this would throw otherwise.
    expect(() => orchestrator.startTask(task.id)).not.toThrow();
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  it.each(["queued", "running"] as const)(
    "returns 409 and leaves the stage unchanged for a task not in Not delivered (%s)",
    async (status) => {
      const task = create("Not eligible");
      if (status === "running") {
        service.setTaskStage(task.id, "DEVELOPMENT");
      }
      const stageBefore = service.getTask(task.id)!.currentStage;

      const response = await reopen(task.id);
      expect(response.status).toBe(409);

      expect(service.getTask(task.id)!.currentStage).toBe(stageBefore);
    },
  );

  it("returns 404 for a nonexistent task id", async () => {
    const response = await reopen("task_does_not_exist");
    expect(response.status).toBe(404);
  });

  it("leaves retryTask's own behavior unmodified", async () => {
    const task = create("Failed for retry");
    orchestrator.startTask(task.id);
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.markStageRunStatus(run.id, "failed", { error: "boom" });
    // Routed through `advanceTask`'s `stage_failed` signal, not a direct
    // `setTaskStage`/`updateTask` write: retry now reads `tasks.failed_stage` /
    // `failure_kind`, which only a real terminal transition populates (§4 of
    // `spec-retry-recovery.md`) — a fabricated FAILED row would otherwise be
    // refused as `no_failed_stage`.
    orchestrator.advanceTask(task.id, {
      kind: "stage_failed",
      stage: "DEVELOPMENT",
      error: "boom",
    });

    // retryTask still only accepts status === "failed" and re-runs the failed
    // stage in place — independent of, and unaffected by, the new reopen
    // route added in this change.
    const transition = orchestrator.retryTask(task.id);
    expect(transition).toMatchObject({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });
});
