import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * S3 — a task's own spend ceiling (`tasks.max_cost_usd`) stops the pipeline
 * from scheduling its next stage once accumulated spend meets or exceeds it.
 * See `scheduleStage`'s admission check in `orchestrator.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-ceiling-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let orchestrator: typeof import("@/server/pipeline/orchestrator");
let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let repoId: string;

beforeAll(async () => {
  orchestrator = await import("@/server/pipeline/orchestrator");
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");

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

describe("per-task spend ceiling", () => {
  it("fails the task terminally before scheduling the next stage once the ceiling is met", () => {
    const task = service.createTask({
      repoId,
      title: "Over budget",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
      maxCostUsd: 1,
    });

    orchestrator.startTask(task.id);
    expect(service.getTask(task.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");

    // Simulate the first stage finishing having already spent past the
    // ceiling — the second stage must never be scheduled.
    const run = service.listStageRuns(task.id).at(-1)!;
    service.markStageRunStatus(run.id, "done", { costUsd: 5 });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "STAKEHOLDER_REFINEMENT",
    });

    const finished = service.getTask(task.id)!;
    expect(finished.currentStage).toBe("FAILED");
    expect(finished.status).toBe("failed");
    expect(finished.failureReason).toContain("$1.00");
    expect(finished.failureReason).toContain("$5.00");
    expect(finished.failedStage).toBe("PO_REFINEMENT");

    // No PO_REFINEMENT run was ever created.
    expect(service.listStageRuns(task.id).some((r) => r.stage === "PO_REFINEMENT")).toBe(false);
  });

  it("frees the concurrency slot so another task can start immediately", () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const overBudget = service.createTask({
      repoId,
      title: "Over budget",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
      maxCostUsd: 1,
    });
    orchestrator.startTask(overBudget.id);
    const run = service.listStageRuns(overBudget.id).at(-1)!;
    service.markStageRunStatus(run.id, "done", { costUsd: 5 });

    orchestrator.advanceTask(overBudget.id, {
      kind: "stage_succeeded",
      stage: "STAKEHOLDER_REFINEMENT",
    });
    expect(service.getTask(overBudget.id)!.status).toBe("failed");

    const other = service.createTask({
      repoId,
      title: "Fits",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    expect(() => orchestrator.startTask(other.id)).not.toThrow();
    expect(service.getTask(other.id)!.status).toBe("running");
  });

  it("does not refuse a task with no ceiling configured", () => {
    const task = service.createTask({
      repoId,
      title: "Unbounded",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);
    const run = service.listStageRuns(task.id).at(-1)!;
    service.markStageRunStatus(run.id, "done", { costUsd: 1000 });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "STAKEHOLDER_REFINEMENT",
    });

    expect(service.getTask(task.id)!.currentStage).toBe("PO_REFINEMENT");
  });
});
