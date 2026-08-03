import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration coverage for the orchestrator against a real SQLite file.
 *
 * The agents themselves are not involved: the test drives the same transition
 * calls the worker makes after a stage succeeds, which is enough to exercise
 * persistence, job scheduling and the QA rework loop.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

type Orchestrator = typeof import("@/server/pipeline/orchestrator");
type Service = typeof import("@/server/tasks/service");
type Queue = typeof import("@/server/jobs/queue");

let orchestrator: Orchestrator;
let service: Service;
let queue: Queue;
let repoId: string;

beforeAll(async () => {
  orchestrator = await import("@/server/pipeline/orchestrator");
  service = await import("@/server/tasks/service");
  queue = await import("@/server/jobs/queue");

  // These tests exercise pipeline transitions, not admission control, and they
  // leave earlier tasks in flight. Admission control is covered on its own in
  // `admission.test.ts`.
  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  // The SQLite handle must be released before the file can be deleted.
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Creates a task and starts it, which is what most of these tests need. */
function newTask(title: string, requireHumanCodeReview = false) {
  const created = service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
    requireHumanCodeReview,
  });
  orchestrator.startTask(created.id);
  return service.getTask(created.id)!;
}

/** Marks the task's current stage run done, mirroring what the worker does. */
function completeCurrentStage(taskId: string, reviewVerdict?: "approved" | "changes_requested") {
  const task = service.getTask(taskId)!;
  const run = service
    .listStageRuns(taskId)
    .filter((candidate) => candidate.stage === task.currentStage)
    .at(-1)!;
  service.markStageRunStatus(run.id, "done");
  orchestrator.advanceTask(taskId, {
    kind: "stage_succeeded",
    stage: task.currentStage,
    reviewVerdict,
  });
}

describe("pipeline orchestration", () => {
  it("starts a task on the stakeholder stage and queues a job for it", () => {
    const task = newTask("First feature");

    expect(task.currentStage).toBe("STAKEHOLDER_REFINEMENT");
    expect(task.status).toBe("running");

    const runs = service.listStageRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stage: "STAKEHOLDER_REFINEMENT", attempt: 1 });

    const job = queue.claimNextJob(1);
    expect(job).toMatchObject({ kind: "run_stage", taskId: task.id });
  });

  it("survives repeated QA cycles without colliding on stage-run attempts", () => {
    const task = newTask("Reworked feature");

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect -> plan gate

    expect(service.getTask(task.id)!.currentStage).toBe("PLAN_GATE");
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });

    // First pass: code review passes, QA rejects.
    completeCurrentStage(task.id); // Development #1
    expect(service.getTask(task.id)!.currentStage).toBe("CODE_REVIEW");
    completeCurrentStage(task.id, "approved"); // Code review #1
    expect(service.getTask(task.id)!.currentStage).toBe("QA");
    completeCurrentStage(task.id, "changes_requested"); // QA #1

    // Second pass. The second CODE_REVIEW and QA runs must get attempt 2, not
    // 1 — the unique index on (task, stage, attempt) would otherwise reject it.
    expect(service.getTask(task.id)!.currentStage).toBe("DEVELOPMENT");
    completeCurrentStage(task.id); // Development #2
    completeCurrentStage(task.id, "approved"); // Code review #2
    completeCurrentStage(task.id, "approved"); // QA #2

    const stages = service.listStageRuns(task.id).map((run) => [run.stage, run.attempt]);
    expect(stages).toEqual([
      ["STAKEHOLDER_REFINEMENT", 1],
      ["PO_REFINEMENT", 1],
      ["ARCHITECTURE", 1],
      ["DEVELOPMENT", 1],
      ["CODE_REVIEW", 1],
      ["QA", 1],
      ["DEVELOPMENT", 2],
      ["CODE_REVIEW", 2],
      ["QA", 2],
      ["PO_HOMOLOGATION", 1],
    ]);

    expect(service.getTask(task.id)!.currentStage).toBe("PO_HOMOLOGATION");
  });

  it("sends a rejected code review back without ever reaching QA", () => {
    const task = newTask("Bad code");

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });
    completeCurrentStage(task.id); // Development #1
    completeCurrentStage(task.id, "changes_requested"); // Code review #1

    expect(service.getTask(task.id)!.currentStage).toBe("DEVELOPMENT");
    expect(
      service.listStageRuns(task.id).some((run) => run.stage === "QA"),
    ).toBe(false);
  });

  it("runs homologation, the delivery gate and delivery to completion", () => {
    const task = newTask("Delivered feature");

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });
    completeCurrentStage(task.id); // Development
    completeCurrentStage(task.id, "approved"); // Code review
    completeCurrentStage(task.id, "approved"); // QA
    completeCurrentStage(task.id); // Homologation

    expect(service.getTask(task.id)!.currentStage).toBe("STAKEHOLDER_GATE");
    expect(service.getTask(task.id)!.status).toBe("awaiting_gate");

    orchestrator.decideGate({
      taskId: task.id,
      gate: "STAKEHOLDER_GATE",
      decision: "approve",
      comment: "Ship it",
    });
    expect(service.getTask(task.id)!.currentStage).toBe("DELIVERY");

    completeCurrentStage(task.id); // Delivery
    const finished = service.getTask(task.id)!;
    expect(finished.currentStage).toBe("COMPLETED");
    expect(finished.status).toBe("completed");

    expect(service.listApprovals(task.id).map((a) => [a.gate, a.decision])).toEqual([
      ["PLAN_GATE", "approve"],
      ["STAKEHOLDER_GATE", "approve"],
    ]);
  });

  it("never enters the human gate when the task did not opt in", () => {
    const task = newTask("No human review", false);

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });
    completeCurrentStage(task.id); // Development
    completeCurrentStage(task.id, "approved"); // Code review
    completeCurrentStage(task.id, "approved"); // QA

    expect(service.getTask(task.id)!.currentStage).toBe("PO_HOMOLOGATION");
  });

  it("parks at the human gate and feeds a request_changes back to the Developer", () => {
    const task = newTask("Needs my eyes", true);

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });
    completeCurrentStage(task.id); // Development
    completeCurrentStage(task.id, "approved"); // Code review
    completeCurrentStage(task.id, "approved"); // QA

    expect(service.getTask(task.id)!.currentStage).toBe("HUMAN_CODE_REVIEW");
    expect(service.getTask(task.id)!.status).toBe("awaiting_gate");

    orchestrator.decideGate({
      taskId: task.id,
      gate: "HUMAN_CODE_REVIEW",
      decision: "request_changes",
      comment: "Extract the retry loop into its own function.",
    });

    // A comment the Developer never sees is worse than useless, so it must be
    // persisted as a real artifact rather than only as an approval row.
    const feedback = service.latestArtifact(task.id, "human_review");
    expect(feedback).not.toBeNull();
    expect(feedback!.contentMd).toContain("## Requested Changes");
    expect(feedback!.contentMd).toContain("Extract the retry loop");
    expect(service.getTask(task.id)!.currentStage).toBe("DEVELOPMENT");
  });

  it("refuses request_changes without a comment", () => {
    const task = newTask("Silent rejection", true);

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });
    completeCurrentStage(task.id); // Development
    completeCurrentStage(task.id, "approved"); // Code review
    completeCurrentStage(task.id, "approved"); // QA

    expect(() =>
      orchestrator.decideGate({
        taskId: task.id,
        gate: "HUMAN_CODE_REVIEW",
        decision: "request_changes",
        comment: "   ",
      }),
    ).toThrow(orchestrator.GateError);

    // Refused atomically: still on the gate, no artifact written.
    expect(service.getTask(task.id)!.currentStage).toBe("HUMAN_CODE_REVIEW");
    expect(service.latestArtifact(task.id, "human_review")).toBeNull();
  });

  it("approves at the human gate and continues to homologation", () => {
    const task = newTask("Approved by me", true);

    completeCurrentStage(task.id); // Stakeholder
    completeCurrentStage(task.id); // Product Owner
    completeCurrentStage(task.id); // Architect
    orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" });
    completeCurrentStage(task.id); // Development
    completeCurrentStage(task.id, "approved"); // Code review
    completeCurrentStage(task.id, "approved"); // QA

    orchestrator.decideGate({
      taskId: task.id,
      gate: "HUMAN_CODE_REVIEW",
      decision: "approve",
    });
    expect(service.getTask(task.id)!.currentStage).toBe("PO_HOMOLOGATION");
  });

  it("rejects the task when the plan gate is rejected", () => {
    const task = newTask("Rejected feature");

    completeCurrentStage(task.id);
    completeCurrentStage(task.id);
    completeCurrentStage(task.id);

    orchestrator.decideGate({
      taskId: task.id,
      gate: "PLAN_GATE",
      decision: "reject",
      comment: "Wrong approach",
    });

    const rejected = service.getTask(task.id)!;
    expect(rejected.currentStage).toBe("REJECTED");
    expect(rejected.status).toBe("rejected");
    expect(rejected.failureReason).toBe("Wrong approach");
  });

  it("refuses a gate decision the task is not waiting on", () => {
    const task = newTask("Wrong gate");
    expect(() =>
      orchestrator.decideGate({ taskId: task.id, gate: "PLAN_GATE", decision: "approve" }),
    ).toThrow(orchestrator.GateError);
  });

  it("cancels an in-flight task and drops its queued jobs", () => {
    const task = newTask("Cancelled feature");
    orchestrator.cancelTask(task.id);

    const cancelled = service.getTask(task.id)!;
    expect(cancelled.currentStage).toBe("CANCELLED");
    expect(queue.taskIsActive(task.id)).toBe(false);
  });

  it("re-runs the failed stage with the next attempt number", () => {
    const task = newTask("Retried feature");

    const run = service.listStageRuns(task.id).at(-1)!;
    service.markStageRunStatus(run.id, "failed", { error: "boom" });
    orchestrator.advanceTask(task.id, {
      kind: "stage_failed",
      stage: "STAKEHOLDER_REFINEMENT",
      error: "boom",
    });
    expect(service.getTask(task.id)!.status).toBe("failed");

    orchestrator.retryTask(task.id);

    const runs = service.listStageRuns(task.id);
    expect(runs.map((r) => [r.stage, r.attempt])).toEqual([
      ["STAKEHOLDER_REFINEMENT", 1],
      ["STAKEHOLDER_REFINEMENT", 2],
    ]);
    expect(service.getTask(task.id)!.status).toBe("running");
  });
});
