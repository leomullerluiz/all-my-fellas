import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "../db/client";
import { newId } from "../db/ids";
import { type JobKind, type JobRow, jobs, tasks } from "../db/schema";

/**
 * Minimal job queue on top of SQLite.
 *
 * The worker polls with {@link claimNextJob}, which uses a conditional UPDATE
 * so the claim is atomic even if a second worker is ever started by accident.
 */

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

/** Number of tasks currently occupying a worker slot. */
export function runningTaskCount(): number {
  const row = db
    .select({ count: sql<number>`count(distinct ${jobs.taskId})` })
    .from(jobs)
    .where(eq(jobs.status, "claimed"))
    .get();
  return row?.count ?? 0;
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
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, Date.now())))
      .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(50)
      .all();

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
