import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `GET /api/tasks/:id`'s `retry` key, and the matching `POST …/retry` 409
 * taxonomy — `spec-retry-recovery.md` §10.1/§10.3, `stories.md` S3.
 *
 * Both routes are backed by the same `computeRetryAvailability`, so every
 * `available: false` code here is also asserted as a distinct, reproducible
 * `POST` precondition rather than only through the `GET` shape.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-retry-availability-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let taskRoute: typeof import("@/app/api/tasks/[id]/route");
let retryRoute: typeof import("@/app/api/tasks/[id]/retry/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  orchestrator = await import("@/server/pipeline/orchestrator");
  taskRoute = await import("@/app/api/tasks/[id]/route");
  retryRoute = await import("@/app/api/tasks/[id]/retry/route");

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

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function create(title: string) {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

async function detail(taskId: string) {
  const response = await taskRoute.GET(new Request("http://test"), params(taskId));
  return (await response.json()) as {
    retry:
      | { available: true; stage: string; attempt: number; cause: string; grantsReworkCycles: number }
      | { available: false; code: string; reason: string };
  };
}

function retry(taskId: string) {
  return retryRoute.POST(new Request("http://test", { method: "POST" }), params(taskId));
}

/** Fails a started task on `stage`, defaulting to the `stage_error` kind. */
function failOnStage(
  title: string,
  stage: "STAKEHOLDER_REFINEMENT" | "DELIVERY",
  failureKind?: "stage_error" | "delivery_failed",
) {
  const task = create(title);
  orchestrator.startTask(task.id);
  if (stage !== "STAKEHOLDER_REFINEMENT") {
    service.setTaskStage(task.id, stage);
  }
  orchestrator.advanceTask(task.id, { kind: "stage_failed", stage, error: "boom", failureKind });
  return task;
}

/** Fails a task on rework exhaustion, with no workspace ever created for it. */
function reworkExhaustedNoWorkspace(title: string) {
  const task = create(title);
  orchestrator.startTask(task.id);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt });
  }
  service.setTaskStage(task.id, "CODE_REVIEW");
  orchestrator.advanceTask(task.id, {
    kind: "stage_succeeded",
    stage: "CODE_REVIEW",
    reviewVerdict: "changes_requested",
  });
  return task;
}

describe("GET /api/tasks/:id retry availability", () => {
  it("reports available: true with the stage, attempt and cause for a plain stage failure", async () => {
    const task = failOnStage("Failed at refinement", "STAKEHOLDER_REFINEMENT");

    const body = await detail(task.id);
    expect(body.retry).toMatchObject({
      available: true,
      stage: "STAKEHOLDER_REFINEMENT",
      attempt: 2,
      cause: "stage_error",
      grantsReworkCycles: 0,
    });
  });

  it("reports not_failed for a task that never failed, naming the actual status", async () => {
    const task = create("Never failed");
    const body = await detail(task.id);
    expect(body.retry).toMatchObject({ available: false, code: "not_failed" });
    expect((body.retry as { reason: string }).reason).toMatch(/not failed/);
  });

  it("reports not_failed for a cancelled task, naming cancellation", async () => {
    const task = create("Cancelled");
    orchestrator.startTask(task.id);
    orchestrator.cancelTask(task.id);

    const body = await detail(task.id);
    expect(body.retry).toMatchObject({ available: false, code: "not_failed" });
    expect((body.retry as { reason: string }).reason).toContain("cancelled");
  });

  it("reports no_failed_stage when failed_stage was never recorded (pre-migration gap)", async () => {
    const task = failOnStage("Migration gap", "STAKEHOLDER_REFINEMENT");
    // Simulates a FAILED row that predates the backfill and had no matching
    // stage_runs row to backfill from — see `migrations.ts`'s §4.5 backfill.
    service.updateTask(task.id, { failedStage: null, failureKind: null });

    const body = await detail(task.id);
    expect(body.retry).toMatchObject({ available: false, code: "no_failed_stage" });
  });

  it("reports workspace_gone once the workspace has been removed for a failure that needs branch history", async () => {
    // delivery_failed always needs branch history — §9 of spec-retry-recovery.
    const task = failOnStage("Delivery failed", "DELIVERY", "delivery_failed");

    const body = await detail(task.id);
    expect(body.retry).toMatchObject({ available: false, code: "workspace_gone" });
  });

  it("reports workspace_gone for a rework-exhausted task with no workspace on disk", async () => {
    const task = reworkExhaustedNoWorkspace("Rework exhausted, no workspace");
    expect(service.getTask(task.id)!.failureKind).toBe("rework_exhausted");

    const body = await detail(task.id);
    expect(body.retry).toMatchObject({ available: false, code: "workspace_gone" });
  });

  it("reports capacity, but still names the blocking task, when no slot is free", async () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const task = failOnStage("Failed, capacity blocked", "STAKEHOLDER_REFINEMENT");
    const occupier = create("Occupier");
    orchestrator.startTask(occupier.id);

    const body = await detail(task.id);
    expect(body.retry).toMatchObject({ available: false, code: "capacity" });
    expect((body.retry as { reason: string }).reason).toContain("Occupier");
  });
});

describe("POST /api/tasks/:id/retry 409 taxonomy", () => {
  it("returns not_failed for a task that has not failed", async () => {
    const task = create("Never failed");
    const response = await retry(task.id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("not_failed");
  });

  it("returns no_failed_stage for a FAILED task with no recorded cause", async () => {
    const task = failOnStage("Migration gap", "STAKEHOLDER_REFINEMENT");
    service.updateTask(task.id, { failedStage: null, failureKind: null });

    const response = await retry(task.id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("no_failed_stage");
  });

  it("returns workspace_gone once the workspace is gone for a failure that needs branch history", async () => {
    const task = failOnStage("Delivery failed", "DELIVERY", "delivery_failed");

    const response = await retry(task.id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("workspace_gone");
  });

  it("returns capacity when no slot is free, with no rework_budget_grant written", async () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const task = failOnStage("Blocked", "STAKEHOLDER_REFINEMENT");
    const occupier = create("Occupier");
    orchestrator.startTask(occupier.id);

    const response = await retry(task.id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("capacity");
    expect(service.getTask(task.id)!.reworkBudgetGrant).toBe(0);
  });

  it("returns 404 for a nonexistent task", async () => {
    const response = await retry("task_does_not_exist");
    expect(response.status).toBe(404);
  });
});
