import { and, asc, eq, gt, lte } from "drizzle-orm";

import { db } from "../db/client";
import { type JobKind, jobs, tasks } from "../db/schema";
import { DIFFICULTY_RANK, inFlightTaskIds, PRIORITY_RANK, taskWorkOnly } from "../jobs/queue";

/**
 * What the worker is doing with a task right now, derived at render time from
 * `tasks.status` plus `jobs` — never persisted, never fed back into the state
 * machine. See `docs/spec/spec-execution-honesty.md` §4.
 *
 * Two facts the UI used to conflate: *admitted* (`tasks.status === "running"`,
 * a concurrency slot held) and *in flight* (the worker has this task's job
 * claimed right now). The worker runs one job at a time, so above
 * `maxParallelTasks = 1` most admitted tasks are waiting, not running.
 */
export type ExecutionState =
  /**
   * The worker has this task's job claimed. `job` separates an LLM session
   * from delivery (pushes and calls a REST API, no agent) and verification
   * (mechanical install/build/test/lint commands, no agent) — both real work,
   * neither an agent "running".
   */
  | { kind: "in_flight"; job: "agent" | "delivery" | "verification" }
  /** Admitted; job enqueued and eligible, waiting for the worker to reach it. */
  | { kind: "waiting_for_worker"; position: number; depth: number }
  /** Admitted; job back at `pending` with a future `runAfter` after a retryable failure. */
  | { kind: "retry_backoff"; retryAt: number; attempt: number }
  /**
   * Admitted, but with neither a claimed nor an eligible pending job. Not the
   * ordinary gap between stages — `scheduleStage` enqueues the next job before
   * the worker marks the finished one done, so that window is `in_flight`.
   * Either read skew across the three queries below (removed by the shared
   * transaction) or a task genuinely stranded by a failed `advanceTask` —
   * see `worker/index.ts`'s `handleJobFailure`.
   */
  | { kind: "settling" }
  /** Not admitted: `CREATED`, `on_queue`, `awaiting_gate`, `gate_queued`, or terminal. */
  | { kind: "idle" };

/** Maps a claimed job's kind to what the UI says is running. */
function jobToUiKind(kind: JobKind): "agent" | "delivery" | "verification" {
  switch (kind) {
    case "run_stage":
      return "agent";
    case "deliver":
      return "delivery";
    case "verify":
      return "verification";
    case "cleanup_workspace":
    case "quota_wake":
      // Filtered out of every query below — see the `taskWorkOnly()`
      // clauses. Reaching this would mean the filter was dropped somewhere.
      throw new Error(`${kind} is not an in-flight job kind.`);
  }
}

/**
 * Computes {@link ExecutionState} for every admitted task, from three reads:
 * the claimed job (if any), the eligible pending queue in the exact order
 * {@link "../jobs/queue".claimNextJob} will drain it, and pending jobs still in
 * retry backoff.
 *
 * A task with no entry in the returned map is `idle` — the caller defaults it
 * rather than this function writing an `idle` entry for every task in the
 * database, most of which are not admitted.
 *
 * The three reads share one read-only transaction so a commit landing between
 * them cannot produce a task that is both `in_flight` and `waiting_for_worker`
 * (or neither) for the same render. This calls none of `orchestrator.ts`'s
 * transition entry points and writes nothing, so it does not trip the "never
 * call `promoteQueue` from inside an open transaction" rule that guards those.
 */
export function executionStates(): Map<string, ExecutionState> {
  const now = Date.now();

  return db.transaction((tx) => {
    // Same query the worker's own headline count would use — see
    // `inFlightTaskIds`'s docblock and spec §6.1 — reused rather than
    // reimplemented so the two can't drift apart.
    const claimedByTask = inFlightTaskIds(tx);

    // Ordered exactly as `claimNextJob` will drain it: same ranking, same
    // eligibility window (`runAfter <= now`), same job-kind exclusion.
    const eligibleRows = tx
      .select({ taskId: jobs.taskId })
      .from(jobs)
      .innerJoin(tasks, eq(jobs.taskId, tasks.id))
      .where(
        and(eq(jobs.status, "pending"), taskWorkOnly(), lte(jobs.runAfter, now)),
      )
      .orderBy(PRIORITY_RANK, DIFFICULTY_RANK, asc(jobs.runAfter), asc(jobs.createdAt))
      .all();

    const backoffRows = tx
      .select({ taskId: jobs.taskId, runAfter: jobs.runAfter, attempts: jobs.attempts })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), taskWorkOnly(), gt(jobs.runAfter, now)))
      .all();

    const admittedTaskIds = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, "running"))
      .all()
      .map((row) => row.id);

    const states = new Map<string, ExecutionState>();

    // A job whose task already holds a claimed job is skipped by
    // `claimNextJob` (queue.ts:98), so counting it here would place a task in
    // the queue behind itself — mirrored by excluding `claimedByTask` members.
    const eligible = eligibleRows.filter((row) => !claimedByTask.has(row.taskId));
    const depth = eligible.length;
    eligible.forEach((row, index) => {
      states.set(row.taskId, { kind: "waiting_for_worker", position: index + 1, depth });
    });

    for (const row of backoffRows) {
      if (claimedByTask.has(row.taskId)) continue;
      states.set(row.taskId, { kind: "retry_backoff", retryAt: row.runAfter, attempt: row.attempts });
    }

    // Claimed wins over everything: `scheduleStage` enqueues the next job
    // before the worker marks the finished one done, so a task can briefly
    // hold both a claimed and a pending row — see the `settling` doc above.
    for (const [taskId, kind] of claimedByTask) {
      states.set(taskId, { kind: "in_flight", job: jobToUiKind(kind) });
    }

    for (const taskId of admittedTaskIds) {
      if (!states.has(taskId)) states.set(taskId, { kind: "settling" });
    }

    return states;
  });
}

/** `executionStates()`'s map defaults every unlisted task to `idle`. */
export function executionStateFor(
  taskId: string,
  states: Map<string, ExecutionState>,
): ExecutionState {
  return states.get(taskId) ?? { kind: "idle" };
}
