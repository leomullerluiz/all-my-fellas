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
let queue: typeof import("@/server/jobs/queue");
let repoId: string;

beforeAll(async () => {
  orchestrator = await import("@/server/pipeline/orchestrator");
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  queue = await import("@/server/jobs/queue");

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
    // Mirrors the worker: the job backing this run is only marked `done`
    // once its handler (which includes the `advanceTask` call below in
    // production) returns — `resumeTask`'s withheld detection depends on
    // this job no longer being pending/claimed by the time it runs.
    queue.completeJob(queue.claimNextJob(5)!.id);

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

  it("does not pause a task with no stage currently in flight (e.g. not yet started)", () => {
    const task = service.createTask({
      repoId,
      title: "Pause before start",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    orchestrator.pauseTask(task.id);

    expect(service.getTask(task.id)!.paused).toBe(false);
  });

  // Code review finding (rework cycle 3): a pause flag left set by an
  // unrelated in-flight failure used to survive into a later retry's "run"
  // transition to the *same* stage, and `resumeTask`'s stage-name comparison
  // could not tell that apart from "nothing was withheld" — leaving the task
  // stuck forever with no job and no error. Both halves are covered below:
  // the terminal transition clearing `paused`, and `resumeTask` no longer
  // relying on stage-name comparison.
  it("clears the pause flag on a terminal transition, so a later retry of the same stage is not silently withheld", () => {
    const task = service.createTask({
      repoId,
      title: "Pause then unrelated failure",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);
    orchestrator.pauseTask(task.id);
    expect(service.getTask(task.id)!.paused).toBe(true);

    // The in-flight stage fails for a reason unrelated to the pause.
    orchestrator.advanceTask(task.id, {
      kind: "stage_failed",
      stage: "STAKEHOLDER_REFINEMENT",
      error: "boom",
    });

    const failed = service.getTask(task.id)!;
    expect(failed.status).toBe("failed");
    // The stale pause flag must not survive the terminal transition.
    expect(failed.paused).toBe(false);

    orchestrator.retryTask(task.id);

    const retried = service.getTask(task.id)!;
    expect(retried.status).toBe("running");
    expect(
      service.listStageRuns(task.id).filter((r) => r.stage === "STAKEHOLDER_REFINEMENT"),
    ).toHaveLength(2);
  });

  it("resumeTask detects a withheld stage even when it shares its name with the task's most recent run", () => {
    const task = service.createTask({
      repoId,
      title: "Pause across a same-name re-entry",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    // Simulate a task already mid-pipeline at a stage that already has an
    // earlier attempt on record (a rework loop) — via `setTaskStage`/
    // `createStageRun` directly rather than `startTask`, so there is no
    // unrelated leftover job for an earlier stage to confuse the check this
    // test exercises.
    service.setTaskStage(task.id, "DEVELOPMENT");
    const firstAttempt = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.markStageRunStatus(firstAttempt.id, "done", { costUsd: 0.1 });

    orchestrator.pauseTask(task.id);
    expect(service.getTask(task.id)!.paused).toBe(true);

    // A "run" transition back to the *same* stage name (attempt 2) is withheld.
    orchestrator.applyTransition(task.id, { type: "run", stage: "DEVELOPMENT", attempt: 2 });
    expect(
      service.listStageRuns(task.id).filter((r) => r.stage === "DEVELOPMENT"),
    ).toHaveLength(1);

    orchestrator.resumeTask(task.id);

    expect(service.getTask(task.id)!.paused).toBe(false);
    expect(
      service.listStageRuns(task.id).filter((r) => r.stage === "DEVELOPMENT"),
    ).toHaveLength(2);
  });
});
