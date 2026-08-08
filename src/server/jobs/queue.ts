import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";

import { db } from "../db/client";
import { newId } from "../db/ids";
import { type JobKind, type JobRow, jobs, tasks } from "../db/schema";

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
 * `difficulty` is set by the Architect, so a freshly started task has `NULL`.
 * It sorts with `M` — neutral — rather than last, which would starve
 * un-estimated work behind anything already estimated.
 *
 * Exported so `../pipeline/execution.ts` can compute a queue position in the
 * exact order `claimNextJob` will actually drain it, rather than retyping the
 * ranking a third time.
 */
export const PRIORITY_RANK = sql`CASE ${tasks.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export const DIFFICULTY_RANK = sql`CASE ${tasks.difficulty}
  WHEN 'S' THEN 0 WHEN 'L' THEN 2 ELSE 1 END`;

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
 * The kind of claimed job each in-flight task holds right now, keyed by task id.
 *
 * `cleanup_workspace` is excluded: it is claimed like any other job, but a
 * workspace deletion is not an agent (or any other stage) running, and the
 * task it belongs to has already finished — see `spec-execution-honesty.md`
 * §6.1. This replaces the never-called `runningTaskCount`, which counted it.
 */
export function inFlightTaskIds(executor: Queryable = db): Map<string, JobKind> {
  const rows = executor
    .select({ taskId: jobs.taskId, kind: jobs.kind })
    .from(jobs)
    .where(and(eq(jobs.status, "claimed"), ne(jobs.kind, "cleanup_workspace")))
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
