import { capacityBlockedReason } from "@/lib/capacity";
import { formatCost, formatDateTime } from "@/lib/utils";

import { db } from "../db/client";
import { appendEvent } from "../events/store";
import { workspaceHasGitDir } from "../git/workspace";
import {
  cancelPendingJobs,
  cancelScheduledCleanup,
  enqueueJob,
  hasActiveJobForTask,
  hasPendingQuotaWake,
} from "../jobs/queue";
import { getSettings } from "../settings/store";
import { type Cadence, resolveQuotaStatus } from "../usage/quota";
import {
  type DependencySummary,
  type EditableTaskFields,
  type NewAttachment,
  activeTasks,
  countStageRuns,
  createStageRun,
  deleteAttachment,
  deleteTask,
  gateQueuedTasks,
  getTask,
  incompleteDependencies,
  insertAttachments,
  listApprovals,
  listDependencies,
  listStageRuns,
  queuedTasks,
  recordApproval,
  saveArtifact,
  setTaskStage,
  totalCostForTask,
  updateTask,
  updateTaskFields,
} from "../tasks/service";
import type { JobKind, TaskRow } from "../db/schema";
import {
  GRANTS_REWORK_CYCLE,
  InvalidGateDecisionError,
  InvalidTransitionError,
  needsBranchHistory,
  type PipelineContext,
  type PipelineSignal,
  RETRY_TARGET,
  type Transition,
  nextTransition,
} from "./state-machine";
import {
  GATE_ALLOWED_DECISIONS,
  type FailureKind,
  type Gate,
  type GateDecision,
  STAGE_LABELS,
  type Stage,
  isAgentStage,
  isGate,
  isTerminalStage,
} from "./stages";

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
function contextFor(task: TaskRow): PipelineContext {
  const settings = getSettings();
  const planGateRequired = !(
    settings.autoApprovePlanForLowCriticality && task.criticality === "low"
  );
  return {
    developmentAttempts: countStageRuns(task.id, "DEVELOPMENT"),
    homologationAttempts: countStageRuns(task.id, "PO_HOMOLOGATION"),
    reworkMaxCycles: settings.reworkMaxCycles,
    reworkBudgetGrant: task.reworkBudgetGrant,
    planGateRequired,
    humanCodeReviewRequired: task.requireHumanCodeReview,
  };
}

/**
 * Job kind for stages that are not executed by `executeAgentStage`. Anything
 * missing here defaults to `"run_stage"` — the shape `DELIVERY` established
 * before `VERIFICATION` needed the same thing.
 */
const NON_AGENT_JOB_KINDS: Partial<Record<Stage, JobKind>> = {
  DELIVERY: "deliver",
  VERIFICATION: "verify",
};

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
    kind: NON_AGENT_JOB_KINDS[stage] ?? "run_stage",
    payload: { stageRunId: run.id },
  });
}

/**
 * Refuses to schedule a stage once the task's own spend ceiling
 * (`tasks.max_cost_usd`) is already met or exceeded — the per-task
 * counterpart to the per-stage ceiling each provider enforces mid-session
 * (§5.2). `null` means no ceiling, so this is a no-op for every task that
 * never set one.
 *
 * Checked *before* scheduling, not inside a running session: this is a
 * between-stage admission check, not the stop-loss a provider applies while
 * a session is in flight.
 */
function ceilingExceededReason(taskId: string): string | null {
  const task = getTask(taskId);
  if (!task || task.maxCostUsd === null) return null;

  const spent = totalCostForTask(taskId);
  if (spent < task.maxCostUsd) return null;

  return (
    `Spend ceiling of ${formatCost(task.maxCostUsd)} reached ` +
    `(${formatCost(spent)} spent so far).`
  );
}

/**
 * Persists a transition and schedules whatever comes next.
 *
 * Returns the transition actually applied — ordinarily `transition` itself,
 * except a `"run"` that immediately exceeds the task's spend ceiling, which
 * is substituted for the terminal `FAILED` transition it produces instead.
 * Every caller that decides whether to call {@link promoteQueue} from a
 * transition's `type` (a terminal or gate outcome frees a concurrency slot)
 * must use this return value, not the transition it passed in — otherwise a
 * ceiling-triggered substitution frees a slot with nothing to notice.
 */
export function applyTransition(taskId: string, transition: Transition): Transition {
  switch (transition.type) {
    case "run": {
      const overCeiling = ceilingExceededReason(taskId);
      if (overCeiling) {
        // Terminal, not a rework signal: the Developer did not produce bad
        // work, the task ran out of money before the stage even started.
        // `failedStage` names the stage that was refused, so a retry (after
        // raising the ceiling) re-runs exactly that one — `RETRY_TARGET`'s
        // `stage_error` mapping already re-runs `failedStage` itself.
        return applyTransition(taskId, {
          type: "terminal",
          stage: "FAILED",
          reason: overCeiling,
          failedStage: transition.stage,
          failureKind: "stage_error",
        });
      }

      // Clears any failure the task previously carried, whether or not this
      // is a retry: a run transition always leaves the task actively running,
      // and a stale failure_reason/failed_stage/failure_kind would otherwise
      // survive on the row (and in the banner) while a later stage executes.
      setTaskStage(taskId, transition.stage, {
        failureReason: null,
        failedStage: null,
        failureKind: null,
      });

      // §9.2/9.3: "finish the current stage, then wait" — the transition
      // still applies (the board shows the real next stage, not a stale
      // one), only the job that would spend money on it is withheld.
      // `resumeTask` detects exactly this withheld state and schedules it.
      if (getTask(taskId)?.paused) {
        appendEvent(taskId, null, {
          type: "log",
          level: "info",
          message: `${STAGE_LABELS[transition.stage]} withheld: task is paused.`,
        });
        return transition;
      }

      scheduleStage(taskId, transition.stage);
      return transition;
    }

    case "await_gate": {
      setTaskStage(taskId, transition.gate);
      appendEvent(taskId, null, { type: "gate_opened", gate: transition.gate });
      return transition;
    }

    case "terminal": {
      setTaskStage(taskId, transition.stage, {
        failureReason: transition.reason ?? null,
        failedStage: transition.failedStage ?? null,
        failureKind: transition.failureKind ?? null,
        // A terminal task has no next stage left to withhold, so a pause set
        // before this transition must not survive it: left `true`, it would
        // silently withhold the very next "run" transition a later retry
        // produces — which targets the *same* failed stage by name, the one
        // case `resumeTask`'s withheld detection cannot itself untangle (see
        // its own comment). Cancel and rejection reach here too; the flag is
        // equally meaningless once nothing is running to pause.
        paused: false,
      });
      cancelPendingJobs(taskId);
      appendEvent(taskId, null, {
        type: "task_finished",
        stage: transition.stage,
        reason: transition.reason,
      });
      scheduleWorkspaceCleanup(taskId);
      return transition;
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

  const transition = nextTransition(task.currentStage, signal, contextFor(task));
  const applied = applyTransition(taskId, transition);
  // A terminal stage or a gate both release the concurrency slot this task
  // held (§8.2), so this is exactly when the next `on_queue` task, if any,
  // can take its place. `promoteQueue` is never itself wrapped in a
  // transaction here — see the warning on its definition. Checked against
  // `applied`, not `transition`: a spend-ceiling substitution (§5.2) can turn
  // a `"run"` into a terminal outcome that still frees the slot.
  if (applied.type === "terminal" || applied.type === "await_gate") {
    promoteQueue();
  }
  return applied;
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
 * Raised when starting a task would leave one of its prerequisites unmet.
 *
 * Independent of {@link CapacityError}: this fires even when a slot is free,
 * and a slot-free, dependency-clear task can still be refused by capacity —
 * see `stories.md`'s S2 acceptance criterion on the two gates' independence.
 */
export class DependencyError extends Error {
  constructor(readonly incomplete: DependencySummary[]) {
    const names = incomplete.map((task) => `"${task.title}"`).join(", ");
    super(
      `Waiting on prerequisite task${incomplete.length === 1 ? "" : "s"}` +
        (names ? `: ${names}.` : "."),
    );
    this.name = "DependencyError";
  }
}

/**
 * Throws unless every prerequisite of `taskId` has reached `COMPLETED`.
 *
 * "Complete" means `currentStage === "COMPLETED"` — `queued`, `on_queue`,
 * `running`, `awaiting_gate`, `failed`, `rejected` and `cancelled` all keep
 * the dependent blocked, with no override.
 */
function assertPrerequisitesMet(taskId: string): void {
  const incomplete = incompleteDependencies(taskId);
  if (incomplete.length > 0) throw new DependencyError(incomplete);
}

/**
 * Raised when starting (or resuming, or retrying) a task would exceed the
 * configured spend quota under `enforcement: "hold"`.
 *
 * Carries what the UI needs to explain itself — the limit, what has been
 * spent, the cadence and when it resets — rather than just refusing. See
 * spec §4.3.
 */
export class QuotaError extends Error {
  constructor(
    readonly limitUsd: number,
    readonly usedUsd: number,
    readonly cadence: Cadence,
    readonly resetAt: number,
  ) {
    super(
      `Spend limit of ${formatCost(limitUsd)} per ${cadence === "daily" ? "day" : "hour"} ` +
        `reached (${formatCost(usedUsd)} used); resets ${formatDateTime(resetAt)}.`,
    );
    this.name = "QuotaError";
  }
}

/**
 * Throws unless admitting this task is within the configured spend quota, or
 * appends a `quota_warning`/`quota_overridden` event and lets it proceed.
 *
 * Must be called inside the same transaction as the transition it guards —
 * same reasoning as {@link assertSlotAvailable} — and before it: money is a
 * harder refusal than concurrency, and the two produce different messages
 * (§4.3).
 *
 * Pool-wide: this checks total spend across every provider against the
 * *Claude* auth mode's configured limit (`resolveQuotaStatus`'s own
 * documented gap, §4.8) — this spec does not segment quota by provider.
 */
function assertWithinQuota(taskId: string, overrideQuota: boolean): void {
  const settings = getSettings();
  if (settings.quotaEnforcement === "off") return;

  const status = resolveQuotaStatus();
  if (status.state !== "exceeded") return;

  if (settings.quotaEnforcement === "warn") {
    appendEvent(taskId, null, {
      type: "quota_warning",
      usedUsd: status.usedUsd,
      limitUsd: status.limitUsd,
      cadence: status.cadence,
    });
    return;
  }

  // enforcement === "hold"
  if (overrideQuota) {
    appendEvent(taskId, null, {
      type: "quota_overridden",
      usedUsd: status.usedUsd,
      limitUsd: status.limitUsd,
      cadence: status.cadence,
    });
    return;
  }

  throw new QuotaError(status.limitUsd, status.usedUsd, status.cadence, status.resetAt);
}

/**
 * Enters the pipeline, subject to admission control.
 *
 * The capacity check and the transition share one transaction so the invariant
 * "at most `MAX_PARALLEL_TASKS` tasks are in flight" cannot be raced. The
 * dependency check runs first: it is a hard, unconditional gate that must
 * win even when a slot happens to be free; quota runs next, since no amount
 * of waiting for a slot fixes a spend refusal (§4.3).
 *
 * @param overrideQuota Skips only {@link assertWithinQuota}'s `"hold"`
 *   refusal — the "Start anyway" affordance. Has no effect on capacity or
 *   dependency refusals, which protect invariants rather than the user's
 *   wallet.
 * @throws {DependencyError} when a prerequisite has not reached `COMPLETED`.
 * @throws {QuotaError} when `enforcement: "hold"` and usage is over the
 *   configured limit, unless `overrideQuota` is set.
 * @throws {CapacityError} when no slot is free.
 * @throws {InvalidTransitionError} when the task is not at `CREATED`.
 */
export function startTask(taskId: string, options: { overrideQuota?: boolean } = {}): Transition {
  return db.transaction(() => {
    assertPrerequisitesMet(taskId);
    assertWithinQuota(taskId, options.overrideQuota ?? false);
    assertSlotAvailable();
    const transition = advanceTask(taskId, { kind: "start" });
    appendEvent(taskId, null, { type: "task_started" });
    return transition;
  });
}

/**
 * Ranking mirroring {@link "../jobs/queue".claimNextJob}'s `PRIORITY_RANK` /
 * `DIFFICULTY_RANK`, but computed in JS: the batch sorts a handful of already
 * fetched rows rather than issuing another query, so there is no SQL
 * ordering to share with `queue.ts` here.
 */
const PRIORITY_RANK: Record<TaskRow["priority"], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DIFFICULTY_RANK: Record<string, number> = { S: 0, M: 1, L: 2 };

function difficultyRank(difficulty: TaskRow["difficulty"]): number {
  return difficulty ? (DIFFICULTY_RANK[difficulty] ?? 1) : 1;
}

/**
 * Priority-descending, difficulty-ascending order — shared by
 * {@link startTasksBatch} (initial batch order) and {@link promoteQueue}
 * (which `on_queue` task goes next), so the queue drains in the same order it
 * was presented.
 */
function sortByPriorityThenDifficulty(tasksToSort: TaskRow[]): TaskRow[] {
  return [...tasksToSort].sort((a, b) => {
    const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return difficultyRank(a.difficulty) - difficultyRank(b.difficulty);
  });
}

/**
 * Starts or resumes the highest-priority eligible queued task, if a slot is
 * free.
 *
 * Two kinds of task wait in the queue: `on_queue` (a `CREATED` task that lost
 * the capacity race on start, or whose prerequisites were unmet —
 * `startTasksBatch`) and `gate_queued` (a gated task whose approval already
 * resolved to `run` but lost the capacity race on resume — `decideGate`).
 * Both are ranked together through the same
 * {@link sortByPriorityThenDifficulty}, first ordered oldest-queued-first so
 * equal-priority tasks resume in the order they were queued (§8.5 / the
 * approval-queue spec's FIFO requirement), then dispatched to {@link startTask}
 * or {@link resumeGatedTask} by status.
 *
 * Called after any transition that frees a concurrency slot (a terminal
 * outcome or a gate) so a "Start selected" batch, or a run of gate approvals
 * made at capacity, keeps draining without a poller. One call promotes at
 * most one task, since one transition frees at most one slot; each
 * subsequent slot-freeing transition calls this again.
 *
 * A `CapacityError` or a `QuotaError` stops the loop outright — every
 * remaining candidate would fail the same admission check (a quota refusal
 * refuses every candidate in the same instant, exactly like capacity), so
 * trying them is wasted work — one `costSince` call, not one per candidate.
 * The per-candidate races — `DependencyError`, `InvalidTransitionError` (the
 * task was started elsewhere in the same instant), `TaskNotFoundError`
 * (cancelled/deleted meanwhile) and `StaleQueueEntryError` (the `gate_queued`
 * equivalent) — say nothing about the rest of the queue, so the loop moves on
 * to the next candidate. Skipping a `DependencyError` candidate is also the
 * mechanism behind "dependencies are considered while a task sits in the On
 * Queue column" (`stories.md` S2): a free slot goes to the next eligible task
 * rather than idling. Anything else is an unanticipated failure that would
 * otherwise strand a task in the queue with zero signal, so it is logged, and
 * the loop still moves on rather than leaving the rest of the queue stalled.
 *
 * MUST NOT be called from inside an open `db.transaction()` — it calls
 * {@link startTask} or {@link resumeGatedTask}, both of which open their own.
 * `advanceTask` is safe (no caller wraps it in a transaction); `decideGate`
 * calls this only after its own transaction has committed. A future call
 * site that adds a transition inside a transaction and expects promotion "to
 * just happen" would silently miss it.
 */
export function promoteQueue(): void {
  const candidates = sortByPriorityThenDifficulty(
    [...queuedTasks(), ...gateQueuedTasks()].sort((a, b) => a.updatedAt - b.updatedAt),
  );

  for (const candidate of candidates) {
    try {
      if (candidate.status === "gate_queued") {
        resumeGatedTask(candidate.id);
      } else {
        startTask(candidate.id);
      }
      return;
    } catch (error) {
      if (error instanceof CapacityError || error instanceof QuotaError) return;

      const expected =
        error instanceof DependencyError ||
        error instanceof InvalidTransitionError ||
        error instanceof TaskNotFoundError ||
        error instanceof StaleQueueEntryError;
      if (!expected) {
        console.error("[promoteQueue]", error instanceof Error ? error.message : error);
      }
      // Try the next candidate rather than giving up on the whole queue.
    }
  }
}

export type BatchStartResult = {
  taskId: string;
  title: string;
  started: boolean;
  /** True when the task was parked at `on_queue` rather than genuinely failing to start. */
  queued: boolean;
  reason: string | null;
};

/**
 * Starts several `CREATED` tasks in one action, in priority-descending,
 * difficulty-ascending order — the same rule {@link claimNextJob} already
 * applies to queued stage jobs.
 *
 * Each task is started through the ordinary {@link startTask}, one at a time,
 * so admission control is re-checked before every single one exactly as it
 * would be for a sequence of manual clicks. A task that loses the capacity
 * race is parked at `on_queue` instead of being left indistinguishable at
 * `CREATED`/`queued` — {@link promoteQueue} starts it automatically once a
 * slot frees. A task that fails for any other reason (already started,
 * missing) is recorded and skipped without aborting the rest of the batch —
 * see `techplan.md`'s "Partial-failure semantics are new" risk note.
 */
export function startTasksBatch(taskIds: string[]): BatchStartResult[] {
  const found = taskIds
    .map((id) => getTask(id))
    .filter((task): task is TaskRow => task !== null);

  const sorted = sortByPriorityThenDifficulty(found);

  const results: BatchStartResult[] = [];
  const foundIds = new Set(found.map((task) => task.id));
  const missing = taskIds.filter((id) => !foundIds.has(id));
  for (const id of missing) {
    results.push({
      taskId: id,
      title: "Unknown task",
      started: false,
      queued: false,
      reason: "Task not found.",
    });
  }

  for (const task of sorted) {
    try {
      startTask(task.id);
      results.push({ taskId: task.id, title: task.title, started: true, queued: false, reason: null });
    } catch (error) {
      if (error instanceof CapacityError) {
        updateTask(task.id, { status: "on_queue" });
        results.push({
          taskId: task.id,
          title: task.title,
          started: false,
          queued: true,
          reason: capacityBlockedReason({ slotAvailable: false, limit: error.limit, blocking: error.blocking })!,
        });
        continue;
      }
      if (error instanceof DependencyError) {
        // Parked at `on_queue` exactly like a capacity refusal: `promoteQueue`
        // is what re-checks this task once its prerequisites (or a slot)
        // change, rather than requiring a second manual start.
        updateTask(task.id, { status: "on_queue" });
        results.push({
          taskId: task.id,
          title: task.title,
          started: false,
          queued: true,
          reason: error.message,
        });
        continue;
      }
      if (error instanceof QuotaError) {
        // Parked exactly like the two refusals above; also schedules the
        // period-boundary wake-up that re-checks it without waiting for an
        // unrelated slot-freeing transition — see §4.5.
        updateTask(task.id, { status: "on_queue" });
        if (!hasPendingQuotaWake()) {
          enqueueJob({ taskId: task.id, kind: "quota_wake", runAfter: error.resetAt });
        }
        results.push({
          taskId: task.id,
          title: task.title,
          started: false,
          queued: true,
          reason: error.message,
        });
        continue;
      }
      const reason =
        error instanceof InvalidTransitionError
          ? "This task has already been started."
          : error instanceof Error
            ? error.message
            : "Could not start this task.";
      results.push({ taskId: task.id, title: task.title, started: false, queued: false, reason });
    }
  }

  return results;
}

/**
 * Applies an edit to a task that has not started yet.
 *
 * Any `newAttachments` are added alongside the field changes, under the same
 * gate — a task past `CREATED` refuses both.
 *
 * @throws {TaskNotFoundError} when the task does not exist.
 * @throws {GateError} when the task has already left `CREATED`.
 */
export function editTask(
  taskId: string,
  fields: EditableTaskFields,
  newAttachments: NewAttachment[] = [],
): void {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (task.currentStage !== "CREATED") {
    throw new GateError(
      `Only tasks that have not started can be edited; this one is at ${task.currentStage}.`,
    );
  }

  const { dependsOn, ...taskFields } = fields;
  const changed = (Object.keys(taskFields) as Array<keyof typeof taskFields>).filter(
    (key) => task[key] !== taskFields[key],
  );

  // `dependsOn` is not a column on `tasks`, so it cannot go through the same
  // `task[key] !== fields[key]` comparison as the rest of the fields.
  const currentDependsOn = listDependencies(taskId)
    .map((dependency) => dependency.id)
    .sort();
  const nextDependsOn = [...dependsOn].sort();
  const dependenciesChanged =
    currentDependsOn.length !== nextDependsOn.length ||
    currentDependsOn.some((id, index) => id !== nextDependsOn[index]);

  updateTaskFields(taskId, fields);
  if (newAttachments.length > 0) {
    insertAttachments(taskId, newAttachments);
  }
  if (changed.length > 0 || dependenciesChanged || newAttachments.length > 0) {
    appendEvent(taskId, null, {
      type: "task_edited",
      fields: dependenciesChanged ? [...changed, "dependsOn"] : changed,
    });
  }
}

/** Raised when an attachment id does not exist, or belongs to another task. */
export class AttachmentNotFoundError extends Error {
  constructor(taskId: string, attachmentId: string) {
    super(`Attachment ${attachmentId} not found on task ${taskId}.`);
    this.name = "AttachmentNotFoundError";
  }
}

/**
 * Removes one attachment from a task that has not started yet.
 *
 * @throws {TaskNotFoundError} when the task does not exist.
 * @throws {GateError} when the task has already left `CREATED`.
 * @throws {AttachmentNotFoundError} when the id is unknown or belongs to
 * another task.
 */
export function removeAttachment(taskId: string, attachmentId: string): void {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (task.currentStage !== "CREATED") {
    throw new GateError(
      `Only tasks that have not started can be edited; this one is at ${task.currentStage}.`,
    );
  }

  if (!deleteAttachment(taskId, attachmentId)) {
    throw new AttachmentNotFoundError(taskId, attachmentId);
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
 * Raised when a `gate_queued` task no longer matches what `promoteQueue`
 * expected it to be — e.g. cancelled, deleted, or already resumed by a
 * concurrent call. An expected race, not a bug: the next slot-freeing event
 * will simply re-rank whatever is left in the queue.
 */
export class StaleQueueEntryError extends Error {
  constructor(taskId: string, detail: string) {
    super(`Task ${taskId} is no longer a valid gate-queued entry: ${detail}.`);
    this.name = "StaleQueueEntryError";
  }
}

/**
 * Records a human gate decision and resumes the pipeline.
 *
 * Rejects when the task is not parked on that gate, so a stale browser tab
 * cannot approve a stage twice. This includes a task already `gate_queued`
 * on that same gate: `currentStage` deliberately stays put while a decision
 * is queued (so `resumeGatedTask` has something to replay), so `currentStage
 * !== input.gate` alone can no longer tell a fresh decision apart from a
 * duplicate one — a double click, a second tab, or a retried request landing
 * after the first decision was already accepted and queued must not record a
 * second, possibly conflicting `approvals` row or silently override the
 * pending one.
 *
 * The decision itself — the `approvals` row, the `gate_decided` event, and
 * any `request_changes` review artifact — is always persisted, regardless of
 * capacity. Gated tasks no longer hold a slot (§8.2), so resuming one back
 * into `run` is itself a re-admission: another task may have taken the slot
 * while this one waited for approval. When that happens the decision is
 * *not* rejected — the task is parked at `gate_queued` instead, and
 * `promoteQueue` resumes it automatically once a slot frees (mirrors
 * `on_queue` for a capacity-blocked start). `reject` and an exhausted
 * `request_changes` are terminal and release a slot instead, so only the
 * `run` outcome ever needs the check.
 */
export function decideGate(input: {
  taskId: string;
  gate: Gate;
  decision: GateDecision;
  comment?: string;
}): { transition: Transition; queued: boolean } {
  const { transition, queued } = db.transaction(() => {
    const task = getTask(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);
    if (task.currentStage !== input.gate) {
      throw new GateError(
        `Task is at ${task.currentStage}, not waiting on ${input.gate}.`,
      );
    }
    if (task.status === "gate_queued") {
      throw new GateError(
        `Task already has a queued decision on ${input.gate}; it is waiting for a slot to resume.`,
      );
    }
    if (!GATE_ALLOWED_DECISIONS[input.gate].includes(input.decision)) {
      throw new InvalidGateDecisionError(input.gate, input.decision);
    }

    recordApproval(input);
    appendEvent(input.taskId, null, {
      type: "gate_decided",
      gate: input.gate,
      decision: input.decision,
      comment: input.comment,
    });

    // A comment the Developer never sees is worse than useless — the same code
    // would come back. Persist it as a real artifact so it flows through the
    // existing input machinery in `gatherInputs`.
    if (input.decision === "request_changes") {
      const comment = input.comment?.trim();
      if (!comment) {
        throw new GateError("Requesting changes needs a comment saying what to change.");
      }
      // `artifacts.stage_run_id` is NOT NULL and making it nullable would mean
      // rebuilding the table in SQLite. The run the reviewer was looking at is
      // the honest owner anyway, so the artifact hangs off that.
      const reviewedRun = listStageRuns(input.taskId).at(-1);
      if (!reviewedRun) {
        throw new GateError("The task has no stage run to attach the review to.");
      }
      saveArtifact({
        taskId: input.taskId,
        stageRunId: reviewedRun.id,
        type: "human_review",
        contentMd: `## Requested Changes\n\n${comment}\n`,
      });
    }

    const signal: PipelineSignal = {
      kind: "gate_decided",
      gate: input.gate,
      decision: input.decision,
      comment: input.comment,
    };
    const transition = nextTransition(task.currentStage, signal, contextFor(task));

    if (transition.type === "run" && !capacity().slotAvailable) {
      // The decision is kept; only its effect is deferred. `currentStage`
      // stays on the gate, so this same row is what `resumeGatedTask` replays.
      updateTask(input.taskId, { status: "gate_queued" });
      return { transition, queued: true };
    }

    const applied = applyTransition(input.taskId, transition);
    return { transition: applied, queued: false };
  });

  // Outside the transaction: `reject` and an exhausted `request_changes` are
  // terminal and free this task's slot, which is exactly when the next
  // queued task — `on_queue` or `gate_queued` — can take it. `promoteQueue`
  // opens its own transaction, so it must run after this one has committed.
  // Queuing itself (the branch above) frees no slot, so it does not call
  // `promoteQueue`. Checked against the *applied* transition — a `"run"`
  // that immediately exceeded the spend ceiling (§5.2) is substituted for a
  // terminal one and still frees the slot.
  if (transition.type === "terminal") {
    promoteQueue();
  }
  return { transition, queued };
}

/**
 * Resumes a task parked at `gate_queued` once a slot has freed.
 *
 * Replays the most recently recorded approval for the gate the task is still
 * sitting on. That row is unambiguously the pending decision because a
 * `gate_queued` task's `currentStage` never changes while parked — nothing
 * else touches it until this function (or a cancellation) does. Re-evaluates
 * `nextTransition` against *current* settings, the same narrow gap
 * `techplan.md` notes for `reworkMaxCycles` on a re-admitted `request_changes`.
 *
 * Admission-checked inside its own transaction, the same shape `startTask`
 * uses, so two `promoteQueue` calls racing for the last slot cannot both
 * resume a task.
 *
 * @throws {StaleQueueEntryError} when the task no longer exists, is no
 * longer `gate_queued`, or is no longer sitting on a gate — expected races,
 * not bugs.
 * @throws {GateError} when no approval row exists for the gate — a real bug,
 * since a `gate_queued` task can only exist after `decideGate` recorded one.
 * @throws {QuotaError} when `enforcement: "hold"` and usage is over the
 * configured limit.
 * @throws {CapacityError} when no slot is free after all.
 */
export function resumeGatedTask(taskId: string): Transition {
  const applied = db.transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new StaleQueueEntryError(taskId, "the task no longer exists");
    if (task.status !== "gate_queued") {
      throw new StaleQueueEntryError(taskId, `status is now ${task.status}`);
    }
    if (!isGate(task.currentStage)) {
      throw new StaleQueueEntryError(taskId, `current stage ${task.currentStage} is not a gate`);
    }
    const gate = task.currentStage;

    const approval = listApprovals(taskId)
      .filter((row) => row.gate === gate)
      .at(-1);
    if (!approval) {
      throw new GateError(`Task ${taskId} is gate_queued on ${gate} with no recorded approval.`);
    }

    assertWithinQuota(taskId, false);
    assertSlotAvailable();

    const signal: PipelineSignal = {
      kind: "gate_decided",
      gate,
      decision: approval.decision,
      comment: approval.comment ?? undefined,
    };
    const transition = nextTransition(task.currentStage, signal, contextFor(task));
    return applyTransition(taskId, transition);
  });

  // A `"run"` that immediately exceeded the spend ceiling (§5.2) is
  // substituted for a terminal one inside `applyTransition` and still frees
  // the slot this resume just took — `promoteQueue` (this function's only
  // caller) would otherwise never notice. Ordinarily a no-op: resuming into
  // `"run"` is the overwhelmingly common case here.
  if (applied.type === "terminal") {
    promoteQueue();
  }
  return applied;
}

/** Why a retry was refused — mirrored by `available: false` on {@link RetryAvailability}. */
export type RetryRefusalCode =
  | "not_failed"
  | "no_failed_stage"
  | "workspace_gone"
  | "capacity";

/**
 * Raised by {@link retryTask} for every refusal except capacity, which stays
 * {@link CapacityError} so both routes report it identically.
 */
export class NotRetryableError extends Error {
  constructor(
    readonly code: Exclude<RetryRefusalCode, "capacity">,
    message: string,
  ) {
    super(message);
    this.name = "NotRetryableError";
  }
}

/**
 * Whether — and how — a task can be retried right now. Computed by
 * {@link computeRetryAvailability} and consumed both by `GET /api/tasks/:id`
 * (§10.1) and by {@link retryTask} itself, so the coded refusal and the
 * `available: false` code can never disagree.
 */
export type RetryAvailability =
  | {
      available: true;
      stage: Stage;
      attempt: number;
      cause: FailureKind;
      grantsReworkCycles: number;
      /** The rework ceiling this task would have after the retry. */
      reworkMaxCycles: number;
    }
  | { available: false; code: RetryRefusalCode; reason: string };

function notFailedReason(status: TaskRow["status"]): string {
  switch (status) {
    case "completed":
      return "Only a failed task can be retried — this one completed successfully.";
    case "rejected":
      return "Only a failed task can be retried — this one was rejected.";
    case "cancelled":
      return "Only a failed task can be retried — this one was cancelled.";
    default:
      return "Only a failed task can be retried — this one has not failed.";
  }
}

/**
 * Decides whether `task` can be retried, and what a retry would do.
 *
 * Pure given the task row plus the current settings, capacity and workspace
 * state — no mutation. `retryTask` re-runs this inside its own transaction
 * before touching anything, so a refusal here and the 409 it produces are the
 * same computation.
 */
export function computeRetryAvailability(task: TaskRow): RetryAvailability {
  if (task.status !== "failed") {
    return { available: false, code: "not_failed", reason: notFailedReason(task.status) };
  }
  if (!task.failedStage || !task.failureKind) {
    return {
      available: false,
      code: "no_failed_stage",
      reason:
        "This task failed before the pipeline recorded which stage to re-run. " +
        "Create a new task from the same description.",
    };
  }

  const failureKind = task.failureKind as FailureKind;
  const failedStage = task.failedStage as Stage;
  const stage = RETRY_TARGET[failureKind](failedStage);
  // The failed run's attempt is exactly how many runs `failedStage` has ever
  // had: `currentStage` is FAILED, so no run has started since. No ordered
  // scan needed (§8.4).
  const failedRunAttempt = countStageRuns(task.id, failedStage);

  if (
    needsBranchHistory(failedStage, failureKind, failedRunAttempt) &&
    !workspaceHasGitDir(task.id)
  ) {
    const { workspaceRetentionDays } = getSettings();
    return {
      available: false,
      code: "workspace_gone",
      reason:
        `The workspace was removed after ${workspaceRetentionDays} day(s). The branch and ` +
        `its commits are no longer on disk, so there is nothing to re-run ${STAGE_LABELS[stage]} against.`,
    };
  }

  if (!capacity().slotAvailable) {
    return {
      available: false,
      code: "capacity",
      reason: capacityBlockedReason(capacity()) ?? "No capacity slot is free right now.",
    };
  }

  const grantsReworkCycles = GRANTS_REWORK_CYCLE[failureKind] ? 1 : 0;
  const { reworkMaxCycles } = getSettings();
  return {
    available: true,
    stage,
    attempt: countStageRuns(task.id, stage) + 1,
    cause: failureKind,
    grantsReworkCycles,
    reworkMaxCycles: reworkMaxCycles + task.reworkBudgetGrant + grantsReworkCycles,
  };
}

/** `GET /api/tasks/:id`'s `retry` key, and what feeds the detail page's button. */
export function retryAvailability(taskId: string): RetryAvailability | null {
  const task = getTask(taskId);
  if (!task) return null;
  return computeRetryAvailability(task);
}

/**
 * Re-runs the stage a task failed on.
 *
 * Reads `tasks.failed_stage`/`failure_kind` (via {@link computeRetryAvailability})
 * instead of scanning `stage_runs` — the earlier heuristic found nothing after
 * a rework-budget exhaustion (no run there is `"failed"`) and a stale row after
 * an earlier stage failed, was retried, and succeeded. A new stage run is
 * created with the next attempt number rather than reusing the failed one, so
 * the audit trail keeps both the failure and the retry.
 *
 * `failed` is terminal, so a retry re-admits the task and is capacity-checked
 * like a fresh start — otherwise it would be a hole in the invariant. The
 * pending workspace-cleanup job the original failure scheduled is dropped
 * before the transition applies, so it cannot delete the workspace out from
 * under the retried run (§8.1).
 *
 * @throws {TaskNotFoundError} when the task does not exist.
 * @throws {QuotaError} when `enforcement: "hold"` and usage is over the
 * configured limit — a granted rework cycle is new spend and passes the same
 * admission check a fresh start would.
 * @throws {NotRetryableError} when the task has not failed, has no recorded
 * cause, or its workspace is gone.
 * @throws {CapacityError} when no slot is free.
 */
export function retryTask(taskId: string): Transition {
  const applied = db.transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const availability = computeRetryAvailability(task);
    // Hard, unconditional refusals (not failed / no recorded cause / workspace
    // gone) win even over quota — same reasoning as `assertPrerequisitesMet`
    // running before `assertWithinQuota` in `startTask`. Quota runs before
    // capacity, since no amount of waiting for a slot fixes a spend refusal.
    if (!availability.available && availability.code !== "capacity") {
      throw new NotRetryableError(availability.code, availability.reason);
    }

    assertWithinQuota(taskId, false);

    if (!availability.available) {
      throw new CapacityError(getSettings().maxParallelTasks, capacity().blocking);
    }

    cancelScheduledCleanup(taskId);

    if (availability.grantsReworkCycles > 0) {
      updateTask(taskId, {
        reworkBudgetGrant: task.reworkBudgetGrant + availability.grantsReworkCycles,
      });
    }

    appendEvent(taskId, null, {
      type: "log",
      level: "info",
      message:
        `Retrying ${availability.stage} (attempt ${availability.attempt}).` +
        (availability.grantsReworkCycles > 0
          ? ` Grants ${availability.grantsReworkCycles} extra rework cycle(s).`
          : ""),
    });

    const transition: Transition = {
      type: "run",
      stage: availability.stage,
      attempt: availability.attempt,
    };
    return applyTransition(taskId, transition);
  });

  // A retry is normally always `"run"` — `RETRY_TARGET` never produces a
  // terminal outcome on its own. The one exception is a spend ceiling that
  // was already exceeded when the retry was admitted (§5.2), substituted for
  // a terminal transition inside `applyTransition`; that still frees the
  // slot the retry just re-admitted into, so `promoteQueue` must run.
  if (applied.type === "terminal") {
    promoteQueue();
  }
  return applied;
}

/**
 * Resets a Not-delivered task back to `CREATED` so it can be started again.
 *
 * Unlike {@link retryTask}, which re-runs the specific stage a `failed` task
 * stopped on in place, this is a full reset available to every terminal
 * outcome in the "Not delivered" column — `REJECTED`, `FAILED`, and
 * `CANCELLED` alike — and lands the task back at `CREATED`/`queued` exactly
 * like a freshly created one, rather than resuming mid-pipeline. It is not a
 * pipeline transition (no `nextTransition`/`applyTransition`, no stage
 * scheduled, no job enqueued), so it goes straight through `setTaskStage`.
 *
 * Note: this does not cancel the workspace-retention cleanup job the earlier
 * terminal transition scheduled (`scheduleWorkspaceCleanup`) — the same gap
 * already exists, undocumented as a fix, for `retryTask` (see
 * `spec-retry-recovery.md` §8.1) and is out of scope here too.
 *
 * @throws {TaskNotFoundError} when the task does not exist.
 * @throws {GateError} when the task is not currently `REJECTED`, `FAILED`, or
 * `CANCELLED`.
 */
export function reopenTask(taskId: string): TaskRow {
  return db.transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (!["REJECTED", "FAILED", "CANCELLED"].includes(task.currentStage)) {
      throw new GateError(
        `Only tasks in Rejected, Failed, or Cancelled can be moved to Created; this task is at ${task.currentStage}.`,
      );
    }

    appendEvent(taskId, null, {
      type: "log",
      level: "info",
      message: `Moved back to Created from ${task.currentStage}.`,
    });

    return setTaskStage(taskId, "CREATED")!;
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

/**
 * Sets the "finish the current stage, then wait" flag (§9.2). Does not touch
 * whatever stage is currently running — that keeps going to completion; only
 * the *next* `scheduleStage` call (in `applyTransition`'s `"run"` case) is
 * withheld. Safe to call on an already-paused task (idempotent) or a
 * finished one (a no-op with nothing left to withhold).
 *
 * Restricted to `running`/`awaiting_gate`: those are the only statuses with a
 * current stage actually in front of the user for this to let finish before
 * withholding the next one. A task that has not started yet (`queued`,
 * `on_queue`) or is already parked (`gate_queued`) has nothing in flight to
 * pause — allowing it there only widened the surface for a stray `paused`
 * flag to silently withhold a later `startTask`/`resumeGatedTask` transition.
 */
export function pauseTask(taskId: string): void {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (task.paused) return;
  if (task.status !== "running" && task.status !== "awaiting_gate") return;

  updateTask(taskId, { paused: true });
  appendEvent(taskId, null, {
    type: "log",
    level: "info",
    message: "Task paused: the current stage will finish, then wait before the next one.",
  });
}

/**
 * Clears the pause flag and, if a stage was actually withheld while paused,
 * schedules it.
 *
 * "Withheld" is detected rather than tracked by a separate column, but not by
 * comparing the most recently created stage run's stage against
 * `current_stage`: that comparison looks identical — a "match", meaning "not
 * withheld" — whenever the withheld stage shares its name with the task's own
 * most recent run, which is exactly what a rework loop or a retry of a failed
 * stage produces (the previous attempt's run already carries that same stage
 * name). Instead this checks {@link hasActiveJobForTask}: `scheduleStage`
 * always enqueues a job in the same breath it changes `current_stage` to a
 * schedulable stage (see `applyTransition`'s `"run"` case), so "no
 * pending/claimed job for this task" is exact evidence that the stage was
 * withheld rather than scheduled, independent of stage names or attempt
 * numbers.
 */
export function resumeTask(taskId: string): void {
  const task = getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  if (!task.paused) return;

  updateTask(taskId, { paused: false });
  appendEvent(taskId, null, { type: "log", level: "info", message: "Task resumed." });

  if (isGate(task.currentStage) || isTerminalStage(task.currentStage)) return;

  const withheld = !hasActiveJobForTask(taskId);
  if (withheld) scheduleStage(taskId, task.currentStage);
}

/** Approvals already recorded, newest first — used to render the timeline. */
export function approvalHistory(taskId: string) {
  return listApprovals(taskId).reverse();
}
