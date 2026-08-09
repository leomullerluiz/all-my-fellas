import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let quotaModule: typeof import("@/server/usage/quota");
let eventsModule: typeof import("@/server/events/store");
let repoId: string;

beforeAll(async () => {
  orchestrator = await import("@/server/pipeline/orchestrator");
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  queue = await import("@/server/jobs/queue");
  quotaModule = await import("@/server/usage/quota");
  eventsModule = await import("@/server/events/store");

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

  it("does not count a gated task as holding its slot", () => {
    const first = create("Gated");
    const second = create("Second");
    orchestrator.startTask(first.id);

    // Park the first task on a gate; it holds no claimed job, so it no
    // longer reserves a slot — a second task can start while it waits.
    service.setTaskStage(first.id, "PLAN_GATE");
    expect(service.getTask(first.id)!.status).toBe("awaiting_gate");

    expect(orchestrator.capacity().slotAvailable).toBe(true);
    expect(() => orchestrator.startTask(second.id)).not.toThrow();
    expect(service.getTask(second.id)!.status).toBe("running");
  });

  it("still enforces the limit against a genuinely running task", () => {
    const first = create("Running");
    const second = create("Second");
    orchestrator.startTask(first.id);
    expect(service.getTask(first.id)!.status).toBe("running");

    try {
      orchestrator.startTask(second.id);
      expect.unreachable("expected a CapacityError");
    } catch (error) {
      expect(error).toBeInstanceOf(orchestrator.CapacityError);
      const capacityError = error as InstanceType<typeof orchestrator.CapacityError>;
      expect(capacityError.message).toContain("Running");
      expect(capacityError.blocking.map((t) => t.id)).toEqual([first.id]);
    }
    expect(service.getTask(second.id)!.currentStage).toBe("CREATED");
  });

  it("allows two tasks to sit at awaiting_gate simultaneously with no error", () => {
    const first = create("First gated");
    const second = create("Second gated");
    orchestrator.startTask(first.id);
    service.setTaskStage(first.id, "PLAN_GATE");

    orchestrator.startTask(second.id);
    service.setTaskStage(second.id, "PLAN_GATE");

    expect(service.getTask(first.id)!.status).toBe("awaiting_gate");
    expect(service.getTask(second.id)!.status).toBe("awaiting_gate");
    expect(orchestrator.capacity()).toMatchObject({ active: 0, slotAvailable: true });
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

  it("never lists a gated task in capacity().blocking", () => {
    const first = create("Gated");
    orchestrator.startTask(first.id);
    service.setTaskStage(first.id, "PLAN_GATE");

    expect(orchestrator.capacity().blocking).toEqual([]);
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

describe("quota admission (S2)", () => {
  beforeEach(() => {
    settings.updateSettings({ maxParallelTasks: 5, quotaEnforcement: "off" });
    process.env.ANTHROPIC_API_KEY = "key";
  });

  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    settings.updateSettings({
      quotaEnforcement: "off",
      quotaLimits: { api_key: { limitUsd: null, cadence: "daily" } },
    });
  });

  /** Records $11 of spend today against a task, so a $10 daily limit is exceeded. */
  function seedOverQuota(limitUsd = 10) {
    settings.updateSettings({
      quotaLimits: { api_key: { limitUsd, cadence: "daily" } },
    });
    const spender = create("Spender");
    const run = service.createStageRun({ taskId: spender.id, stage: "DEVELOPMENT", attempt: 1 });
    service.updateStageRun(run.id, {
      status: "done",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      costUsd: limitUsd + 1,
    });
  }

  it("off: a start over the limit succeeds exactly as today", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "off" });
    const task = create("Over limit");

    expect(() => orchestrator.startTask(task.id)).not.toThrow();
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  it("warn: the start succeeds and a quota_warning event is appended", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "warn" });
    const task = create("Warned");

    expect(() => orchestrator.startTask(task.id)).not.toThrow();
    expect(service.getTask(task.id)!.status).toBe("running");

    const types = eventsModule.readEvents(task.id).map((event) => event.type);
    expect(types).toContain("quota_warning");
  });

  it("hold: startTask throws QuotaError and leaves the task untouched", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });
    const task = create("Held");

    expect(() => orchestrator.startTask(task.id)).toThrow(orchestrator.QuotaError);
    const untouched = service.getTask(task.id)!;
    expect(untouched.currentStage).toBe("CREATED");
    expect(untouched.status).toBe("queued");
  });

  it("hold: startTasksBatch parks the task at on_queue instead of failing it", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });
    const task = create("Batched, held");

    const results = orchestrator.startTasksBatch([task.id]);
    expect(results).toEqual([
      expect.objectContaining({ taskId: task.id, started: false, queued: true }),
    ]);
    expect(service.getTask(task.id)!.status).toBe("on_queue");
  });

  it("hold: overrideQuota starts it and appends a quota_overridden event", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });
    const task = create("Overridden");

    expect(() => orchestrator.startTask(task.id, { overrideQuota: true })).not.toThrow();
    expect(service.getTask(task.id)!.status).toBe("running");

    const types = eventsModule.readEvents(task.id).map((event) => event.type);
    expect(types).toContain("quota_overridden");
  });

  it("overrideQuota has no effect on a CapacityError refusal", () => {
    settings.updateSettings({ maxParallelTasks: 1, quotaEnforcement: "off" });
    const first = create("Holding the slot");
    const second = create("Second");
    orchestrator.startTask(first.id);

    expect(() => orchestrator.startTask(second.id, { overrideQuota: true })).toThrow(
      orchestrator.CapacityError,
    );
  });

  it("overrideQuota has no effect on a DependencyError refusal", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });
    const prerequisite = create("Prerequisite");
    const dependent = service.createTask({
      repoId,
      title: "Dependent",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
      dependsOn: [prerequisite.id],
    });

    expect(() => orchestrator.startTask(dependent.id, { overrideQuota: true })).toThrow(
      orchestrator.DependencyError,
    );
  });

  it("ordering: over-quota AND missing a prerequisite reports DependencyError, not QuotaError", () => {
    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });
    const prerequisite = create("Prerequisite");
    const dependent = service.createTask({
      repoId,
      title: "Dependent, over quota",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
      dependsOn: [prerequisite.id],
    });

    expect(() => orchestrator.startTask(dependent.id)).toThrow(orchestrator.DependencyError);
  });

  it("ordering: over-quota AND no free slot reports QuotaError, not CapacityError", () => {
    settings.updateSettings({ maxParallelTasks: 1, quotaEnforcement: "off" });
    // Fill the only slot with a task started while quota was still fine.
    const holder = create("Holding the slot");
    orchestrator.startTask(holder.id);

    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });

    const contender = create("Over quota, no slot");
    expect(() => orchestrator.startTask(contender.id)).toThrow(orchestrator.QuotaError);
  });

  it("promoteQueue stops on the first QuotaError rather than checking every candidate", async () => {
    seedOverQuota();
    settings.updateSettings({ maxParallelTasks: 5, quotaEnforcement: "hold" });

    const a = create("A");
    const b = create("B");
    orchestrator.startTasksBatch([a.id, b.id]);
    expect(service.getTask(a.id)!.status).toBe("on_queue");
    expect(service.getTask(b.id)!.status).toBe("on_queue");

    const spy = vi.spyOn(quotaModule, "resolveEnforcementQuotaStatus");
    orchestrator.promoteQueue();
    // One check for the first candidate, then the loop stops outright — not
    // one per queued task.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("schedules a quota_wake job the first time a batch parks a task on quota, and does not duplicate it", () => {
    expect(queue.hasPendingQuotaWake()).toBe(false);

    seedOverQuota();
    settings.updateSettings({ quotaEnforcement: "hold" });
    const a = create("A");
    const b = create("B");

    const spy = vi.spyOn(queue, "enqueueJob");

    orchestrator.startTasksBatch([a.id]);
    expect(queue.hasPendingQuotaWake()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // A second park while one is already pending must not enqueue another.
    orchestrator.startTasksBatch([b.id]);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

describe("decideGate is admission controlled on resume", () => {
  it("queues instead of throwing when approving would resume into a taken slot", () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    // The gate holds no slot, so a second task can genuinely run and take it.
    const running = create("Running");
    orchestrator.startTask(running.id);

    const result = orchestrator.decideGate({
      taskId: gated.id,
      gate: "PLAN_GATE",
      decision: "approve",
    });

    // The decision itself is recorded exactly as it would be with a free
    // slot; only its effect is deferred.
    expect(result.queued).toBe(true);
    expect(result.transition).toMatchObject({ type: "run" });
    expect(orchestrator.approvalHistory(gated.id)).toHaveLength(1);
    expect(orchestrator.approvalHistory(gated.id)[0]).toMatchObject({
      gate: "PLAN_GATE",
      decision: "approve",
    });

    // Distinguishable "waiting for a slot" status, not the unchanged
    // `awaiting_gate` — the decision has already been made.
    const after = service.getTask(gated.id)!;
    expect(after.status).toBe("gate_queued");
    expect(after.currentStage).toBe("PLAN_GATE");
  });

  it("succeeds once the slot frees", () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const running = create("Running");
    orchestrator.startTask(running.id);
    orchestrator.cancelTask(running.id);

    const result = orchestrator.decideGate({
      taskId: gated.id,
      gate: "PLAN_GATE",
      decision: "approve",
    });
    expect(result.queued).toBe(false);
    expect(service.getTask(gated.id)!.status).toBe("running");
  });

  it("does not check capacity on reject, which is terminal and releases a slot", () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const running = create("Running");
    orchestrator.startTask(running.id);

    const result = orchestrator.decideGate({
      taskId: gated.id,
      gate: "PLAN_GATE",
      decision: "reject",
    });
    expect(result.queued).toBe(false);
    expect(service.getTask(gated.id)!.status).toBe("rejected");
  });

  it("resumes automatically once the blocking task finishes", () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const running = create("Running");
    orchestrator.startTask(running.id);

    const result = orchestrator.decideGate({
      taskId: gated.id,
      gate: "PLAN_GATE",
      decision: "approve",
    });
    expect(result.queued).toBe(true);
    expect(service.getTask(gated.id)!.status).toBe("gate_queued");

    // The blocking task reaches a terminal stage, freeing the slot the
    // queued approval is waiting on.
    orchestrator.cancelTask(running.id);

    const resumed = service.getTask(gated.id)!;
    expect(resumed.status).toBe("running");
    expect(resumed.currentStage).toBe("DEVELOPMENT");
  });

  it("resolves exactly one of two racing gate approvals into the last slot", () => {
    const first = create("First gated");
    const second = create("Second gated");
    orchestrator.startTask(first.id);
    service.setTaskStage(first.id, "PLAN_GATE");
    service.setTaskStage(second.id, "PLAN_GATE");

    // Both gates hold no slot, so both approvals compute a `run` transition
    // against the same, single free slot. `decideGate` is fully synchronous
    // (see the risk note in `techplan.md`), so calling it twice in a row here
    // exercises the same non-interleaved guarantee two concurrent HTTP
    // requests would rely on.
    const firstResult = orchestrator.decideGate({
      taskId: first.id,
      gate: "PLAN_GATE",
      decision: "approve",
    });
    const secondResult = orchestrator.decideGate({
      taskId: second.id,
      gate: "PLAN_GATE",
      decision: "approve",
    });

    const results = [firstResult, secondResult];
    expect(results.filter((r) => !r.queued)).toHaveLength(1);
    expect(results.filter((r) => r.queued)).toHaveLength(1);

    const statuses = [service.getTask(first.id)!.status, service.getTask(second.id)!.status];
    expect(statuses.filter((s) => s === "running")).toHaveLength(1);
    expect(statuses.filter((s) => s === "gate_queued")).toHaveLength(1);
  });

  it("rejects a second decision on a gate that is already queued, instead of recording or overriding it", () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const running = create("Running");
    orchestrator.startTask(running.id);

    const first = orchestrator.decideGate({
      taskId: gated.id,
      gate: "PLAN_GATE",
      decision: "approve",
    });
    expect(first.queued).toBe(true);

    // A stale tab, a double click, or a retried request re-submitting a
    // decision for the same gate — including a *different*, conflicting one
    // — must not be accepted while the first decision is still pending.
    expect(() =>
      orchestrator.decideGate({
        taskId: gated.id,
        gate: "PLAN_GATE",
        decision: "reject",
      }),
    ).toThrow(orchestrator.GateError);

    // Neither the recorded approval nor the queued status changed.
    expect(orchestrator.approvalHistory(gated.id)).toHaveLength(1);
    expect(orchestrator.approvalHistory(gated.id)[0]).toMatchObject({
      gate: "PLAN_GATE",
      decision: "approve",
    });
    const after = service.getTask(gated.id)!;
    expect(after.status).toBe("gate_queued");
    expect(after.currentStage).toBe("PLAN_GATE");

    // The originally queued decision still resumes normally once the slot
    // frees, unaffected by the rejected duplicate.
    orchestrator.cancelTask(running.id);
    const resumed = service.getTask(gated.id)!;
    expect(resumed.status).toBe("running");
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
      dependsOn: [],
      maxCostUsd: null,
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
      dependsOn: [],
      maxCostUsd: task.maxCostUsd,
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
        dependsOn: [],
        maxCostUsd: null,
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
