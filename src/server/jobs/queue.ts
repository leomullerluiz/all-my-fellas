import { and, asc, eq, inArray, lte, notInArray } from "drizzle-orm";

import { db } from "../db/client";
import { newId } from "../db/ids";
import { type JobKind, type JobRow, jobs, tasks } from "../db/schema";
import { DIFFICULTY_RANK, PRIORITY_RANK } from "../pipeline/task-ranking";

/**
 * Minimal job queue on top of SQLite.
 *
 * The worker polls with {@link claimNextJob}, which uses a conditional UPDATE
 * so the claim is atomic even if a second worker is ever started by accident.
 */

/**
 * Ordering used when several jobs are eligible in the same tick: highest
 * priority first, lowest estimated complexity as the tiebreaker, then FIFO.
 *
 * Re-exported from `../pipeline/task-ranking` — the single definition shared
 * with the orchestrator's JS comparator and the board's On Queue column, see
 * that module's docblock. Kept re-exported here (rather than requiring every
 * caller to switch imports) since this file's own `claimNextJob` already
 * refers to `queue.ts` for these names.
 */
export { DIFFICULTY_RANK, PRIORITY_RANK };

/** Transient job failures are retried twice with backoff before the task fails. */
export const MAX_JOB_ATTEMPTS = 3;

export type RunStagePayload = { stageRunId: string };
export type DeliverPayload = Record<string, never>;
export type CleanupPayload = { deleteAfter: number };

export type EnqueueOptions = {
  taskId: string;
  kind: JobKind;
  payload?: Record<string, unknown>;
  /** Epoch ms; defaults to now. */
  runAfter?: number;
};

export function enqueueJob({
  taskId,
  kind,
  payload = {},
  runAfter = Date.now(),
}: EnqueueOptions): string {
  const id = newId("job");
  db.insert(jobs)
    .values({
      id,
      taskId,
      kind,
      payloadJson: JSON.stringify(payload),
      runAfter,
      status: "pending",
    })
    .run();
  return id;
}

/**
 * Anything with a `.select()` shaped like {@link db}'s — either `db` itself or
 * the `tx` handed to a `db.transaction()` callback. Letting callers pass a
 * transaction is what lets {@link inFlightTaskIds} be reused from inside
 * `../pipeline/execution.ts`'s single read-only transaction instead of being
 * reimplemented there.
 */
type Queryable = Pick<typeof db, "select">;

/**
 * Job kinds that are claimed and run like any other, but are not the pipeline
 * work of the task whose id they carry — so reporting either as that task
 * executing would be exactly the conflation `spec-execution-honesty.md` §6.1
 * removes:
 *
 * - `cleanup_workspace` deletes a workspace after its task has already
 *   finished.
 * - `quota_wake`'s effect (`promoteQueue()`) is global; its `taskId` is merely
 *   whichever park happened to schedule it (see `db/schema.ts`'s `JOB_KINDS`).
 *
 * A new kind in this category is excluded from the claimed, eligible and
 * backoff reads by one edit here.
 */
const NON_TASK_JOB_KINDS: JobKind[] = ["cleanup_workspace", "quota_wake"];

/**
 * `WHERE` fragment keeping only jobs that are a task's own pipeline work.
 *
 * Exported as the condition rather than as the list so `../pipeline/execution.ts`
 * cannot filter on a subset of it by accident — every execution-state read
 * spells the exclusion the same way, or not at all.
 */
export function taskWorkOnly() {
  return notInArray(jobs.kind, NON_TASK_JOB_KINDS);
}

/**
 * The kind of claimed job each in-flight task holds right now, keyed by task id.
 *
 * {@link taskWorkOnly} excludes the non-task kinds. This replaces the
 * never-called `runningTaskCount`, which counted `cleanup_workspace`.
 */
export function inFlightTaskIds(executor: Queryable = db): Map<string, JobKind> {
  const rows = executor
    .select({ taskId: jobs.taskId, kind: jobs.kind })
    .from(jobs)
    .where(and(eq(jobs.status, "claimed"), taskWorkOnly()))
    .all();
  return new Map(rows.map((row) => [row.taskId, row.kind]));
}

/**
 * Atomically claims the oldest eligible job.
 *
 * Jobs for tasks that already have a claimed job are skipped so a single task
 * never runs two stages at once, and the parallelism cap counts distinct tasks
 * rather than jobs.
 */
export function claimNextJob(maxParallelTasks: number): JobRow | null {
  return db.transaction((tx) => {
    const busyTaskIds = tx
      .selectDistinct({ taskId: jobs.taskId })
      .from(jobs)
      .where(eq(jobs.status, "claimed"))
      .all()
      .map((row) => row.taskId);

    if (busyTaskIds.length >= maxParallelTasks) return null;

    const candidates = tx
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(tasks, eq(jobs.taskId, tasks.id))
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, Date.now())))
      .orderBy(PRIORITY_RANK, DIFFICULTY_RANK, asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(50)
      .all()
      .map((row) => row.job);

    const next = candidates.find((job) => !busyTaskIds.includes(job.taskId));
    if (!next) return null;

    const claimed = tx
      .update(jobs)
      .set({ status: "claimed", attempts: next.attempts + 1 })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, "pending")))
      .returning()
      .get();

    return claimed ?? null;
  });
}

/**
 * {@link claimNextJob}, gated by the global queue-hold switch (§9.2).
 *
 * A settings flag rather than job/task state — "stop starting things" is
 * deliberately the cheapest possible implementation: nothing about a job or
 * task changes, so a job already claimed before the flag was set is
 * untouched and runs to completion; only a *new* claim is refused. Split out
 * from the worker's `tick()` so the exact behaviour is testable without
 * importing `worker/index.ts`, which starts its real polling loop
 * unconditionally on import.
 */
export function claimNextJobUnlessHeld(maxParallelTasks: number, queueHeld: boolean): JobRow | null {
  if (queueHeld) return null;
  return claimNextJob(maxParallelTasks);
}

export function completeJob(jobId: string): void {
  db.update(jobs).set({ status: "done" }).where(eq(jobs.id, jobId)).run();
}

/**
 * Marks a claimed job as failed.
 *
 * @param retryAfter When provided, the job returns to `pending` and becomes
 *   eligible again at that timestamp (retry with backoff).
 */
export function failJob(jobId: string, error: string, retryAfter?: number): void {
  db.update(jobs)
    .set(
      retryAfter === undefined
        ? { status: "failed", lastError: error }
        : { status: "pending", lastError: error, runAfter: retryAfter },
    )
    .where(eq(jobs.id, jobId))
    .run();
}

/** Drops every not-yet-started job for a task; used when cancelling. */
export function cancelPendingJobs(taskId: string): void {
  db.update(jobs)
    .set({ status: "failed", lastError: "Task cancelled" })
    .where(and(eq(jobs.taskId, taskId), inArray(jobs.status, ["pending", "claimed"])))
    .run();
}

/**
 * Removes a task's still-pending workspace-cleanup job, if any.
 *
 * A terminal transition always schedules one (`scheduleWorkspaceCleanup`); a
 * retry that re-enters the pipeline must drop it before applying its
 * transition, or the stale job can delete the workspace out from under the
 * retried run — see `spec-retry-recovery.md` §8.1. Deletes rather than
 * marking `failed`, unlike {@link cancelPendingJobs}: `lastError = "Task
 * cancelled"` would be a false statement in the audit trail for a task that
 * is, at this moment, being retried rather than cancelled.
 */
export function cancelScheduledCleanup(taskId: string): void {
  db.delete(jobs)
    .where(
      and(
        eq(jobs.taskId, taskId),
        eq(jobs.kind, "cleanup_workspace"),
        inArray(jobs.status, ["pending", "claimed"]),
      ),
    )
    .run();
}

/**
 * Returns jobs left in `claimed` by a crashed worker back to `pending`.
 *
 * Called once at worker startup: there is exactly one worker, so anything still
 * claimed is by definition orphaned.
 */
export function requeueOrphanedJobs(): number {
  const result = db
    .update(jobs)
    .set({ status: "pending", lastError: "Requeued after worker restart" })
    .where(eq(jobs.status, "claimed"))
    .returning({ id: jobs.id })
    .all();
  return result.length;
}

/**
 * Whether a `quota_wake` job is already pending, regardless of which task
 * it is attached to — the job's effect (`promoteQueue()`) is global, so a
 * second one enqueued while the first is still pending would just call
 * `promoteQueue` twice for nothing (§4.5).
 */
export function hasPendingQuotaWake(): boolean {
  return (
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, "quota_wake"), eq(jobs.status, "pending")))
      .get() !== undefined
  );
}

/**
 * Whether `taskId` currently has a job that is pending or claimed, for any
 * stage.
 *
 * `resumeTask` (§9.2) uses this to detect whether a stage was actually
 * withheld while paused, instead of comparing the most recent stage run's
 * stage name against `tasks.current_stage`. Name comparison breaks the
 * instant a withheld stage shares its name with the task's own most recent
 * run — exactly what happens on a rework loop or a `retryTask` re-run, where
 * the "same stage again" run that was withheld looks identical, by name, to
 * the earlier attempt that already completed. `scheduleStage` always creates
 * its `stage_runs` row and enqueues a job in the same breath (`applyTransition`'s
 * `"run"` case), so "no active job for this task" is exact evidence that the
 * stage was withheld rather than scheduled.
 */
export function hasActiveJobForTask(taskId: string): boolean {
  return (
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.taskId, taskId), inArray(jobs.status, ["pending", "claimed"])))
      .get() !== undefined
  );
}

export function parsePayload<T>(job: JobRow): T {
  return JSON.parse(job.payloadJson) as T;
}

/** True when the task still exists and has not reached a terminal stage. */
export function taskIsActive(taskId: string): boolean {
  const row = db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return false;
  return row.status === "queued" || row.status === "running" || row.status === "awaiting_gate";
}
