import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * S6 — pausing a task withholds the *next* stage's job (not the one
 * currently running); resuming schedules exactly the stage that was
 * withheld. See `orchestrator.ts`'s `pauseTask`/`resumeTask` and the
 * `applyTransition` "run" case they depend on.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-resume-test-"));
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
    name: "acme/pause-resume",
    url: "https://github.com/acme/pause-resume",
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

describe("pause and resume (S6)", () => {
  it("does not enqueue the next stage once the current one finishes while paused, then resumes exactly it", () => {
    const task = service.createTask({
      repoId,
      title: "Pause me",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);
    expect(service.getTask(task.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");

    orchestrator.pauseTask(task.id);
    expect(service.getTask(task.id)!.paused).toBe(true);

    const run = service.listStageRuns(task.id).at(-1)!;
    service.markStageRunStatus(run.id, "done", { costUsd: 0.1 });

    orchestrator.advanceTask(task.id, { kind: "stage_succeeded", stage: "STAKEHOLDER_REFINEMENT" });

    const withheld = service.getTask(task.id)!;
    // The board still reflects the real next stage...
    expect(withheld.currentStage).toBe("PO_REFINEMENT");
    // ...but nothing was scheduled for it.
    expect(service.listStageRuns(task.id).some((r) => r.stage === "PO_REFINEMENT")).toBe(false);

    orchestrator.resumeTask(task.id);

    const resumed = service.getTask(task.id)!;
    expect(resumed.paused).toBe(false);
    const poRuns = service.listStageRuns(task.id).filter((r) => r.stage === "PO_REFINEMENT");
    expect(poRuns).toHaveLength(1);
  });

  it("does not touch the currently in-flight stage's job when paused mid-run", () => {
    const task = service.createTask({
      repoId,
      title: "Pause mid-run",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);
    const runsBefore = service.listStageRuns(task.id);

    orchestrator.pauseTask(task.id);

    // Nothing about the already-scheduled stage changed.
    expect(service.listStageRuns(task.id)).toEqual(runsBefore);
    expect(service.getTask(task.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("resuming a task that was never paused is a harmless no-op", () => {
    const task = service.createTask({
      repoId,
      title: "Never paused",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);
    const runsBefore = service.listStageRuns(task.id);

    expect(() => orchestrator.resumeTask(task.id)).not.toThrow();
    expect(service.listStageRuns(task.id)).toEqual(runsBefore);
  });

  it("pausing twice is idempotent", () => {
    const task = service.createTask({
      repoId,
      title: "Double pause",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);
    orchestrator.pauseTask(task.id);
    orchestrator.pauseTask(task.id);
    expect(service.getTask(task.id)!.paused).toBe(true);
  });
});
