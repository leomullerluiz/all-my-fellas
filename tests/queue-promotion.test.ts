import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Auto-promotion of `on_queue` tasks — S1 AC3/AC5 and S3 of the "On Queue"
 * board column feature.
 *
 * `startTasksBatch`'s own capacity-parking behaviour is covered in
 * `tests/api-tasks-batch-start.test.ts`; this file drives the transitions
 * that are supposed to pick the queue back up (`advanceTask`, `cancelTask`,
 * `decideGate`) rather than writing `status` directly, so `promoteQueue`
 * actually fires the same way it would in the running app.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-promotion-test-"));
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

/** Parks `task` at `on_queue` the way `startTasksBatch` does on a capacity refusal. */
function park(task: { id: string }) {
  service.updateTask(task.id, { status: "on_queue" });
}

describe("promoteQueue via advanceTask", () => {
  it("starts the queued task once the active one reaches a terminal stage (cancel)", () => {
    const active = create("Active");
    const queued = create("Queued");
    orchestrator.startTask(active.id);
    park(queued);

    orchestrator.cancelTask(active.id);

    expect(service.getTask(active.id)!.status).toBe("cancelled");
    expect(service.getTask(queued.id)!.status).toBe("running");
    expect(service.getTask(queued.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("treats a FAILED active task the same as a completion for promotion purposes", () => {
    const active = create("Active");
    const queued = create("Queued");
    orchestrator.startTask(active.id);
    park(queued);

    orchestrator.advanceTask(active.id, {
      kind: "stage_failed",
      stage: "STAKEHOLDER_REFINEMENT",
      error: "boom",
    });

    expect(service.getTask(active.id)!.status).toBe("failed");
    expect(service.getTask(queued.id)!.status).toBe("running");
  });

  it("starts the queued task once the active one reaches a gate, since gates release their slot", () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const active = create("Active");
    const queued = create("Queued");
    orchestrator.startTask(active.id);
    park(queued);

    orchestrator.advanceTask(active.id, {
      kind: "stage_succeeded",
      stage: "STAKEHOLDER_REFINEMENT",
    });
    // STAKEHOLDER_REFINEMENT -> PO_REFINEMENT is a plain `run`, not a gate;
    // drive it to ARCHITECTURE -> PLAN_GATE, which is the actual gate.
    orchestrator.advanceTask(active.id, { kind: "stage_succeeded", stage: "PO_REFINEMENT" });
    orchestrator.advanceTask(active.id, { kind: "stage_succeeded", stage: "ARCHITECTURE" });

    expect(service.getTask(active.id)!.status).toBe("awaiting_gate");
    expect(service.getTask(queued.id)!.status).toBe("running");
  });

  it("drains a multi-task queue one promotion per freed slot, in priority order", () => {
    const active = create("Active");
    const high = create("High");
    const low = create("Low");
    orchestrator.startTask(active.id);
    service.updateTask(high.id, { status: "on_queue", priority: "high" });
    service.updateTask(low.id, { status: "on_queue", priority: "low" });

    orchestrator.cancelTask(active.id);
    expect(service.getTask(high.id)!.status).toBe("running");
    expect(service.getTask(low.id)!.status).toBe("on_queue");

    orchestrator.cancelTask(high.id);
    expect(service.getTask(low.id)!.status).toBe("running");
  });

  it("an individually started task does not preempt a task already on queue", () => {
    // No active task, so a slot is free: a fresh, individually-started task
    // takes it directly, the same as a manual "Start" click always could —
    // it does not get shuffled behind, or ahead of, the queue.
    const queued = create("Queued");
    park(queued);
    const fresh = create("Started individually");

    orchestrator.startTask(fresh.id);

    expect(service.getTask(fresh.id)!.status).toBe("running");
    expect(service.getTask(queued.id)!.status).toBe("on_queue");
  });
});

describe("promoteQueue via decideGate", () => {
  it("promotes the queue when a gate decision is terminal (reject)", () => {
    const gated = create("Gated");
    const queued = create("Queued");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");
    park(queued);

    orchestrator.decideGate({ taskId: gated.id, gate: "PLAN_GATE", decision: "reject" });

    expect(service.getTask(gated.id)!.status).toBe("rejected");
    expect(service.getTask(queued.id)!.status).toBe("running");
  });

  it("does not promote the queue when a gate decision resumes the pipeline (no slot freed)", () => {
    const gated = create("Gated");
    const queued = create("Queued");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");
    park(queued);

    orchestrator.decideGate({ taskId: gated.id, gate: "PLAN_GATE", decision: "approve" });

    expect(service.getTask(gated.id)!.status).toBe("running");
    // No slot was freed by this decision, so the queued task stays put.
    expect(service.getTask(queued.id)!.status).toBe("on_queue");
  });
});

describe("promoteQueue resumes gate_queued tasks (approval queue)", () => {
  /**
   * Parks `task` at `gate_queued`: starts it, moves it to `gate` (freeing its
   * slot, since a gated task holds none), starts `blocker` to take the now-free
   * slot, then approves `task`'s gate — which finds no slot free and queues
   * instead of resuming. Mirrors `tests/admission.test.ts`'s "queues instead
   * of throwing" setup.
   */
  function queueApproval(
    task: { id: string },
    blocker: { id: string },
    gate: "PLAN_GATE" = "PLAN_GATE",
  ) {
    orchestrator.startTask(task.id);
    service.setTaskStage(task.id, gate);
    orchestrator.startTask(blocker.id);
    return orchestrator.decideGate({ taskId: task.id, gate, decision: "approve" });
  }

  it("resumes a gate_queued task once the blocking task reaches a terminal stage", () => {
    const gated = create("Gated");
    const blocker = create("Blocker");
    const result = queueApproval(gated, blocker);

    expect(result.queued).toBe(true);
    expect(service.getTask(gated.id)!.status).toBe("gate_queued");

    orchestrator.cancelTask(blocker.id);

    expect(service.getTask(gated.id)!.status).toBe("running");
    expect(service.getTask(gated.id)!.currentStage).toBe("DEVELOPMENT");
  });

  it("resumes a gate_queued task once the blocking task reaches a gate of its own", () => {
    const gated = create("Gated");
    const blocker = create("Blocker");
    queueApproval(gated, blocker);
    expect(service.getTask(gated.id)!.status).toBe("gate_queued");

    orchestrator.advanceTask(blocker.id, {
      kind: "stage_succeeded",
      stage: "STAKEHOLDER_REFINEMENT",
    });
    orchestrator.advanceTask(blocker.id, { kind: "stage_succeeded", stage: "PO_REFINEMENT" });
    orchestrator.advanceTask(blocker.id, { kind: "stage_succeeded", stage: "ARCHITECTURE" });

    expect(service.getTask(blocker.id)!.status).toBe("awaiting_gate");
    expect(service.getTask(gated.id)!.status).toBe("running");
  });

  it("ranks a gate_queued task against an on_queue task through the same priority ordering", () => {
    const gated = create("Gated");
    const blocker = create("Blocker");
    const startQueued = create("Start queued");
    queueApproval(gated, blocker);
    park(startQueued);
    service.updateTask(startQueued.id, { priority: "high" });
    service.updateTask(gated.id, { priority: "low" });

    orchestrator.cancelTask(blocker.id);

    // Higher priority wins regardless of which queue it came from.
    expect(service.getTask(startQueued.id)!.status).toBe("running");
    expect(service.getTask(gated.id)!.status).toBe("gate_queued");
  });
});

describe("S3 — two gate-queued tasks resume in a predictable order", () => {
  it("resumes FIFO by approval order when priority is equal", () => {
    settings.updateSettings({ maxParallelTasks: 3 });
    const blocker = create("Blocker");
    const taskB = create("Task B");
    const taskC = create("Task C");
    orchestrator.startTask(blocker.id);
    orchestrator.startTask(taskB.id);
    orchestrator.startTask(taskC.id);
    service.setTaskStage(taskB.id, "PLAN_GATE");
    service.setTaskStage(taskC.id, "PLAN_GATE");

    // Only the blocker holds a slot now (the gates hold none), so bring the
    // limit down to 1 to force both approvals to compete for it.
    settings.updateSettings({ maxParallelTasks: 1 });

    // Approve B first, then C — both lose the capacity race and queue.
    orchestrator.decideGate({ taskId: taskB.id, gate: "PLAN_GATE", decision: "approve" });
    orchestrator.decideGate({ taskId: taskC.id, gate: "PLAN_GATE", decision: "approve" });
    expect(service.getTask(taskB.id)!.status).toBe("gate_queued");
    expect(service.getTask(taskC.id)!.status).toBe("gate_queued");

    orchestrator.cancelTask(blocker.id);

    // B was approved first, so it resumes before C is given a slot.
    expect(service.getTask(taskB.id)!.status).toBe("running");
    expect(service.getTask(taskC.id)!.status).toBe("gate_queued");
  });

  it("resumes the higher-priority gate-queued task first when priorities differ", () => {
    settings.updateSettings({ maxParallelTasks: 3 });
    const blocker = create("Blocker");
    const low = create("Low priority");
    const urgent = create("Urgent priority");
    orchestrator.startTask(blocker.id);
    orchestrator.startTask(low.id);
    orchestrator.startTask(urgent.id);
    service.setTaskStage(low.id, "PLAN_GATE");
    service.setTaskStage(urgent.id, "PLAN_GATE");
    service.updateTask(low.id, { priority: "low" });
    service.updateTask(urgent.id, { priority: "urgent" });

    settings.updateSettings({ maxParallelTasks: 1 });

    // Approve the low-priority task first — it would win a pure FIFO race,
    // but priority takes precedence, mirroring `on_queue`'s ordering rule.
    orchestrator.decideGate({ taskId: low.id, gate: "PLAN_GATE", decision: "approve" });
    orchestrator.decideGate({ taskId: urgent.id, gate: "PLAN_GATE", decision: "approve" });

    orchestrator.cancelTask(blocker.id);

    expect(service.getTask(urgent.id)!.status).toBe("running");
    expect(service.getTask(low.id)!.status).toBe("gate_queued");
  });
});

describe("S3 — queue tolerates cancellation or deletion of a waiting task", () => {
  it("cancels a queued task without starting it, leaving the rest of the queue untouched", () => {
    const active = create("Active");
    const queued = create("Queued");
    const other = create("Other queued");
    orchestrator.startTask(active.id);
    park(queued);
    park(other);

    orchestrator.cancelTask(queued.id);

    expect(service.getTask(queued.id)!.status).toBe("cancelled");
    expect(service.getTask(queued.id)!.currentStage).toBe("CANCELLED");
    // The active task still holds the only slot, so nothing else started.
    expect(service.getTask(other.id)!.status).toBe("on_queue");
    expect(service.getTask(active.id)!.status).toBe("running");
  });

  it("deletes a queued task without affecting the rest of the queue", () => {
    const active = create("Active");
    const queued = create("Queued");
    const other = create("Other queued");
    orchestrator.startTask(active.id);
    park(queued);
    park(other);

    orchestrator.deleteCreatedTask(queued.id);

    expect(service.getTask(queued.id)).toBeNull();
    expect(service.getTask(other.id)!.status).toBe("on_queue");
  });

  it("still auto-starts the remaining queued task after a mid-queue cancellation, once a slot frees", () => {
    const active = create("Active");
    const cancelledMidway = create("Cancelled midway");
    const survivor = create("Survivor");
    orchestrator.startTask(active.id);
    park(cancelledMidway);
    park(survivor);

    orchestrator.cancelTask(cancelledMidway.id);
    expect(service.getTask(survivor.id)!.status).toBe("on_queue");

    orchestrator.cancelTask(active.id);
    expect(service.getTask(survivor.id)!.status).toBe("running");
  });

  it("still auto-starts the remaining queued task after a mid-queue deletion, once a slot frees", () => {
    const active = create("Active");
    const deletedMidway = create("Deleted midway");
    const survivor = create("Survivor");
    orchestrator.startTask(active.id);
    park(deletedMidway);
    park(survivor);

    orchestrator.deleteCreatedTask(deletedMidway.id);
    expect(service.getTask(survivor.id)!.status).toBe("on_queue");

    orchestrator.cancelTask(active.id);
    expect(service.getTask(survivor.id)!.status).toBe("running");
  });
});
