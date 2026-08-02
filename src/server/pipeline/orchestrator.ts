import { appendEvent } from "../events/store";
import { cancelPendingJobs, enqueueJob } from "../jobs/queue";
import { getSettings } from "../settings/store";
import {
  countStageRuns,
  createStageRun,
  createTask,
  getTask,
  listApprovals,
  listStageRuns,
  recordApproval,
  setTaskStage,
} from "../tasks/service";
import type { Priority } from "./stages";
import {
  type PipelineContext,
  type PipelineSignal,
  type Transition,
  nextTransition,
} from "./state-machine";
import { type Gate, type GateDecision, type Stage, isAgentStage } from "./stages";

/**
 * Applies pipeline transitions.
 *
 * The state machine decides *what* happens next; this module performs the
 * persistence and queueing that makes it happen. Both processes may call
 * {@link advanceTask} — the web process only for gate decisions and
 * cancellation, the worker for everything else.
 */

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = "TaskNotFoundError";
  }
}

/** Builds the state-machine context from persisted task state and settings. */
function contextFor(taskId: string, criticality: string | null): PipelineContext {
  const settings = getSettings();
  const planGateRequired = !(
    settings.autoApprovePlanForLowCriticality && criticality === "low"
  );
  return {
    developmentAttempts: countStageRuns(taskId, "DEVELOPMENT"),
    qaMaxCycles: settings.qaMaxCycles,
    planGateRequired,
  };
}

/**
 * Creates the stage run for `stage` and queues the job that will execute it.
 *
 * The attempt number is derived from how many runs the stage already has rather
 * than taken from the transition. The state machine only tracks Development
 * attempts, so a second QA or homologation pass after a rework cycle would
 * otherwise reuse attempt 1 and collide with the
 * `(task, stage, attempt)` unique index.
 */
function scheduleStage(taskId: string, stage: Stage): void {
  const settings = getSettings();
  const maxTurns = isAgentStage(stage) ? settings.maxTurns[stage] : undefined;
  const attempt = countStageRuns(taskId, stage) + 1;

  const run = createStageRun({ taskId, stage, attempt, maxTurns });
  enqueueJob({
    taskId,
    kind: stage === "DELIVERY" ? "deliver" : "run_stage",
    payload: { stageRunId: run.id },
  });
}

/** Persists a transition and schedules whatever comes next. */
export function applyTransition(taskId: string, transition: Transition): void {
  switch (transition.type) {
    case "run": {
      setTaskStage(taskId, transition.stage);
      scheduleStage(taskId, transition.stage);
      break;
    }

    case "await_gate": {
      setTaskStage(taskId, transition.gate);
      appendEvent(taskId, null, { type: "gate_opened", gate: transition.gate });
      break;
    }

    case "terminal": {
      setTaskStage(taskId, transition.stage, { failureReason: transition.reason ?? null });
      cancelPendingJobs(taskId);
      appendEvent(taskId, null, {
        type: "task_finished",
        stage: transition.stage,
        reason: transition.reason,
      });
      scheduleWorkspaceCleanup(taskId);
      break;
    }
  }
}

/** Queues workspace removal according to the configured retention window. */
function scheduleWorkspaceCleanup(taskId: string): void {
  const { workspaceRetentionDays } = getSettings();
  const deleteAfter = Date.now() + workspaceRetentionDays * 24 * 60 * 60 * 1000;
  enqueueJob({ taskId, kind: "cleanup_workspace", payload: { deleteAfter }, runAfter: deleteAfter });
}

/** Computes and applies the next transition for `taskId`. */
export function advanceTask(taskId: string, signal: PipelineSignal): Transition {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  const transition = nextTransition(
    task.currentStage,
    signal,
    contextFor(taskId, task.criticality),
  );
  applyTransition(taskId, transition);
  return transition;
}

/** Enters the pipeline. Called right after a task is created. */
export function startTask(taskId: string): void {
  advanceTask(taskId, { kind: "start" });
}

/** Creates a task and immediately enqueues its first stage. */
export function createAndStartTask(input: {
  repoId: string;
  title: string;
  description: string;
  priority: Priority;
}) {
  const created = createTask(input);
  startTask(created.id);
  // `startTask` moves the task to its first stage, so re-read rather than
  // returning the pre-transition snapshot.
  return getTask(created.id) ?? created;
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

/**
 * Records a human gate decision and resumes the pipeline.
 *
 * Rejects when the task is not parked on that gate, so a stale browser tab
 * cannot approve a stage twice.
 */
export function decideGate(input: {
  taskId: string;
  gate: Gate;
  decision: GateDecision;
  comment?: string;
}): Transition {
  const task = getTask(input.taskId);
  if (!task) throw new TaskNotFoundError(input.taskId);
  if (task.currentStage !== input.gate) {
    throw new GateError(
      `Task is at ${task.currentStage}, not waiting on ${input.gate}.`,
    );
  }

  recordApproval(input);
  appendEvent(input.taskId, null, {
    type: "gate_decided",
    gate: input.gate,
    decision: input.decision,
    comment: input.comment,
  });

  return advanceTask(input.taskId, {
    kind: "gate_decided",
    gate: input.gate,
    decision: input.decision,
    comment: input.comment,
  });
}

/**
 * Re-runs the stage a task failed on.
 *
 * A new stage run is created with the next attempt number rather than reusing
 * the failed one, so the audit trail keeps both the failure and the retry.
 */
export function retryTask(taskId: string): Transition {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (task.status !== "failed") {
    throw new GateError(`Only failed tasks can be retried; this task is ${task.status}.`);
  }

  const lastRun = listStageRuns(taskId)
    .filter((run) => run.status === "failed")
    .at(-1);
  if (!lastRun) {
    throw new GateError("No failed stage was found to retry.");
  }

  appendEvent(taskId, null, {
    type: "log",
    level: "info",
    message: `Retrying ${lastRun.stage} (attempt ${lastRun.attempt + 1}).`,
  });

  const transition: Transition = {
    type: "run",
    stage: lastRun.stage,
    attempt: lastRun.attempt + 1,
  };
  applyTransition(taskId, transition);
  return transition;
}

/** Cancels a task from the UI. Safe to call on an already-finished task. */
export function cancelTask(taskId: string): Transition | null {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (["completed", "rejected", "failed", "cancelled"].includes(task.status)) return null;

  appendEvent(taskId, null, { type: "log", level: "warn", message: "Task cancelled by user." });
  return advanceTask(taskId, { kind: "cancel" });
}

/** Approvals already recorded, newest first — used to render the timeline. */
export function approvalHistory(taskId: string) {
  return listApprovals(taskId).reverse();
}
