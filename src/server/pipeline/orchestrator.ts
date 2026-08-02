import { db } from "../db/client";
import { appendEvent } from "../events/store";
import { cancelPendingJobs, enqueueJob } from "../jobs/queue";
import { getSettings } from "../settings/store";
import {
  type EditableTaskFields,
  activeTasks,
  countStageRuns,
  createStageRun,
  deleteTask,
  getTask,
  listApprovals,
  listStageRuns,
  recordApproval,
  setTaskStage,
  updateTaskFields,
} from "../tasks/service";
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

/**
 * Raised when starting a task would exceed `MAX_PARALLEL_TASKS`.
 *
 * Carries the tasks currently holding a slot so the UI can tell the user what
 * to resolve rather than just refusing.
 */
export class CapacityError extends Error {
  constructor(
    readonly limit: number,
    readonly blocking: Array<{ id: string; title: string; status: string }>,
  ) {
    const names = blocking.map((task) => `"${task.title}"`).join(", ");
    super(
      `Limit of ${limit} task${limit === 1 ? "" : "s"} in progress reached` +
        (names ? `; ${names} must finish or be cancelled first.` : "."),
    );
    this.name = "CapacityError";
  }
}

/**
 * Throws unless a concurrency slot is free.
 *
 * Must be called inside the same transaction as the transition it guards, or
 * two concurrent requests can both observe a free slot — see
 * `spec-task-queue.md` §8.2.
 */
function assertSlotAvailable(): void {
  const limit = getSettings().maxParallelTasks;
  const active = activeTasks();
  if (active.length >= limit) throw new CapacityError(limit, active);
}

/** Whether a task could be started right now, for rendering the Start action. */
export function capacity(): {
  limit: number;
  active: number;
  slotAvailable: boolean;
  blocking: Array<{ id: string; title: string; status: string }>;
} {
  const limit = getSettings().maxParallelTasks;
  const active = activeTasks();
  return {
    limit,
    active: active.length,
    slotAvailable: active.length < limit,
    blocking: active,
  };
}

/**
 * Enters the pipeline, subject to admission control.
 *
 * The capacity check and the transition share one transaction so the invariant
 * "at most `MAX_PARALLEL_TASKS` tasks are in flight" cannot be raced.
 *
 * @throws {CapacityError} when no slot is free.
 * @throws {InvalidTransitionError} when the task is not at `CREATED`.
 */
export function startTask(taskId: string): Transition {
  return db.transaction(() => {
    assertSlotAvailable();
    const transition = advanceTask(taskId, { kind: "start" });
    appendEvent(taskId, null, { type: "task_started" });
    return transition;
  });
}

/**
 * Applies an edit to a task that has not started yet.
 *
 * @throws {TaskNotFoundError} when the task does not exist.
 * @throws {GateError} when the task has already left `CREATED`.
 */
export function editTask(taskId: string, fields: EditableTaskFields): void {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (task.currentStage !== "CREATED") {
    throw new GateError(
      `Only tasks that have not started can be edited; this one is at ${task.currentStage}.`,
    );
  }

  const changed = (Object.keys(fields) as Array<keyof EditableTaskFields>).filter(
    (key) => task[key] !== fields[key],
  );

  updateTaskFields(taskId, fields);
  if (changed.length > 0) {
    appendEvent(taskId, null, { type: "task_edited", fields: changed });
  }
}

/**
 * Deletes a task that has not started yet.
 *
 * Restricted to `CREATED` because a started task owns a workspace on disk that
 * a plain row delete would orphan — see `spec-task-queue.md` §7.2.
 *
 * @throws {GateError} when the task has already started.
 */
export function deleteCreatedTask(taskId: string): void {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (task.currentStage !== "CREATED") {
    throw new GateError(
      `Only tasks that have not started can be deleted; this one is at ${task.currentStage}.`,
    );
  }
  deleteTask(taskId);
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
 *
 * `failed` is terminal, so a retry re-admits the task and is capacity-checked
 * like a fresh start — otherwise it would be a hole in the invariant.
 */
export function retryTask(taskId: string): Transition {
  return db.transaction(() => {
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

    assertSlotAvailable();

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
  });
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
