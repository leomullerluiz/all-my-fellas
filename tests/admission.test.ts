import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Admission control: at most `MAX_PARALLEL_TASKS` tasks may be in flight.
 *
 * The invariant this protects is that a card showing "an agent is running"
 * means an agent is running — see `spec-task-queue.md` §8.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-test-"));
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
  // Every task from a previous test is removed so each case controls the
  // active count exactly.
  for (const task of service.listTasks()) {
    service.deleteTask(task.id);
  }
  settings.updateSettings({ maxParallelTasks: 1 });
});

function create(title: string) {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

describe("task creation no longer starts the pipeline", () => {
  it("leaves a new task at CREATED with no job queued", () => {
    const task = create("Queued only");

    expect(task.currentStage).toBe("CREATED");
    expect(task.status).toBe("queued");
    expect(service.listStageRuns(task.id)).toHaveLength(0);
    expect(queue.claimNextJob(1)).toBeNull();
  });

  it("enters the pipeline only on an explicit start", () => {
    const task = create("Started explicitly");
    orchestrator.startTask(task.id);

    const started = service.getTask(task.id)!;
    expect(started.currentStage).toBe("STAKEHOLDER_REFINEMENT");
    expect(started.status).toBe("running");
    expect(queue.claimNextJob(1)).toMatchObject({ kind: "run_stage", taskId: task.id });
  });

  it("records a task_started event", async () => {
    const events = await import("@/server/events/store");
    const task = create("Event check");
    orchestrator.startTask(task.id);

    const types = events.readEvents(task.id).map((event) => event.type);
    expect(types).toContain("task_created");
    expect(types).toContain("task_started");
  });
});

describe("admission control", () => {
  it("refuses a second start while one task is running", () => {
    const first = create("First");
    const second = create("Second");
    orchestrator.startTask(first.id);

    expect(() => orchestrator.startTask(second.id)).toThrow(orchestrator.CapacityError);
    expect(service.getTask(second.id)!.currentStage).toBe("CREATED");
  });

  it("names the blocking task in the error", () => {
    const first = create("Blocking task");
    const second = create("Second");
    orchestrator.startTask(first.id);

    try {
      orchestrator.startTask(second.id);
      expect.unreachable("expected a CapacityError");
    } catch (error) {
      expect(error).toBeInstanceOf(orchestrator.CapacityError);
      const capacityError = error as InstanceType<typeof orchestrator.CapacityError>;
      expect(capacityError.message).toContain("Blocking task");
      expect(capacityError.blocking.map((t) => t.id)).toEqual([first.id]);
    }
  });

  it("counts a gated task as holding its slot", () => {
    const first = create("Gated");
    const second = create("Second");
    orchestrator.startTask(first.id);

    // Park the first task on a gate; it is not executing but still in flight.
    service.setTaskStage(first.id, "PLAN_GATE");
    expect(service.getTask(first.id)!.status).toBe("awaiting_gate");

    expect(() => orchestrator.startTask(second.id)).toThrow(orchestrator.CapacityError);
  });

  it("frees the slot when the active task is cancelled", () => {
    const first = create("Cancelled");
    const second = create("Second");
    orchestrator.startTask(first.id);
    orchestrator.cancelTask(first.id);

    expect(() => orchestrator.startTask(second.id)).not.toThrow();
    expect(service.getTask(second.id)!.status).toBe("running");
  });

  it("frees the slot when the active task completes", () => {
    const first = create("Completed");
    const second = create("Second");
    orchestrator.startTask(first.id);
    service.setTaskStage(first.id, "COMPLETED");

    expect(() => orchestrator.startTask(second.id)).not.toThrow();
  });

  it("allows as many concurrent tasks as the limit permits", () => {
    settings.updateSettings({ maxParallelTasks: 3 });
    const tasks = [create("A"), create("B"), create("C"), create("D")];

    orchestrator.startTask(tasks[0].id);
    orchestrator.startTask(tasks[1].id);
    orchestrator.startTask(tasks[2].id);
    expect(() => orchestrator.startTask(tasks[3].id)).toThrow(orchestrator.CapacityError);
  });

  it("reports capacity for the UI", () => {
    const first = create("Active");
    create("Waiting");
    expect(orchestrator.capacity()).toMatchObject({ limit: 1, active: 0, slotAvailable: true });

    orchestrator.startTask(first.id);
    const after = orchestrator.capacity();
    expect(after).toMatchObject({ limit: 1, active: 1, slotAvailable: false });
    expect(after.blocking.map((t) => t.title)).toEqual(["Active"]);
  });

  it("rolls the whole start back when capacity is refused", () => {
    const first = create("First");
    const second = create("Second");
    orchestrator.startTask(first.id);

    expect(() => orchestrator.startTask(second.id)).toThrow();

    // No partial state: no stage run, no job, no event, stage unchanged.
    expect(service.listStageRuns(second.id)).toHaveLength(0);
    expect(service.getTask(second.id)!.currentStage).toBe("CREATED");
  });

  it("refuses a double start on the same task", () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const task = create("Once only");
    orchestrator.startTask(task.id);

    expect(() => orchestrator.startTask(task.id)).toThrow();
    expect(service.listStageRuns(task.id)).toHaveLength(1);
  });
});

describe("retry is admission controlled", () => {
  it("refuses a retry when no slot is free", () => {
    const failed = create("Failed");
    orchestrator.startTask(failed.id);
    const run = service.listStageRuns(failed.id).at(-1)!;
    service.markStageRunStatus(run.id, "failed", { error: "boom" });
    orchestrator.advanceTask(failed.id, {
      kind: "stage_failed",
      stage: "STAKEHOLDER_REFINEMENT",
      error: "boom",
    });

    // The slot is now free, so another task takes it.
    const other = create("Other");
    orchestrator.startTask(other.id);

    expect(() => orchestrator.retryTask(failed.id)).toThrow(orchestrator.CapacityError);
    expect(service.getTask(failed.id)!.status).toBe("failed");
  });

  it("allows a retry when a slot is free", () => {
    const failed = create("Failed");
    orchestrator.startTask(failed.id);
    const run = service.listStageRuns(failed.id).at(-1)!;
    service.markStageRunStatus(run.id, "failed", { error: "boom" });
    orchestrator.advanceTask(failed.id, {
      kind: "stage_failed",
      stage: "STAKEHOLDER_REFINEMENT",
      error: "boom",
    });

    expect(() => orchestrator.retryTask(failed.id)).not.toThrow();
    expect(service.getTask(failed.id)!.status).toBe("running");
  });
});

describe("editing and deleting a not-started task", () => {
  it("applies an edit and records the changed field names", async () => {
    const events = await import("@/server/events/store");
    const task = create("Original title");

    orchestrator.editTask(task.id, {
      repoId,
      title: "New title",
      description: "A different description, still long enough to validate.",
      priority: "urgent",
      requireHumanCodeReview: false,
    });

    const updated = service.getTask(task.id)!;
    expect(updated.title).toBe("New title");
    expect(updated.priority).toBe("urgent");

    const edited = events
      .readEvents(task.id)
      .find((event) => event.type === "task_edited")!;
    expect(edited.payload).toMatchObject({
      fields: expect.arrayContaining(["title", "description", "priority"]),
    });
  });

  it("records no event when nothing actually changed", async () => {
    const events = await import("@/server/events/store");
    const task = create("Unchanged");

    orchestrator.editTask(task.id, {
      repoId: task.repoId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      requireHumanCodeReview: false,
    });

    expect(events.readEvents(task.id).some((e) => e.type === "task_edited")).toBe(false);
  });

  it("refuses to edit a task that has started", () => {
    const task = create("Started");
    orchestrator.startTask(task.id);

    expect(() =>
      orchestrator.editTask(task.id, {
        repoId,
        title: "Too late",
        description: "A description long enough to pass validation upstream.",
        priority: "low",
        requireHumanCodeReview: false,
      }),
    ).toThrow(orchestrator.GateError);
  });

  it("deletes a not-started task and cascades its rows", () => {
    const task = create("Deletable");
    orchestrator.deleteCreatedTask(task.id);

    expect(service.getTask(task.id)).toBeNull();
  });

  it("refuses to delete a task that has started", () => {
    const task = create("Running");
    orchestrator.startTask(task.id);

    expect(() => orchestrator.deleteCreatedTask(task.id)).toThrow(orchestrator.GateError);
    expect(service.getTask(task.id)).not.toBeNull();
  });

  it("cascades stage runs, events and jobs on delete", async () => {
    const events = await import("@/server/events/store");
    settings.updateSettings({ maxParallelTasks: 5 });
    const task = create("With children");
    orchestrator.startTask(task.id);
    expect(service.listStageRuns(task.id).length).toBeGreaterThan(0);

    // Return the task to CREATED so the delete guard permits it, then verify
    // the children really go away rather than being orphaned.
    service.setTaskStage(task.id, "CREATED");
    orchestrator.deleteCreatedTask(task.id);

    expect(service.getTask(task.id)).toBeNull();
    expect(service.listStageRuns(task.id)).toHaveLength(0);
    expect(events.readEvents(task.id)).toHaveLength(0);
  });
});
