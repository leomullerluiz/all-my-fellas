import { appendEvent } from "../server/events/store";
import { MAX_JOB_ATTEMPTS, failJob, parsePayload, taskIsActive } from "../server/jobs/queue";
import { StageJobError } from "../server/pipeline/execute";
import { advanceTask } from "../server/pipeline/orchestrator";
import type { JobRow } from "../server/db/schema";
import { getStageRun, markStageRunStatus } from "../server/tasks/service";

/**
 * Split out from `index.ts` so it can be unit tested without importing the
 * worker entrypoint — `index.ts` calls `main()` unconditionally at module
 * load, which would start the real polling loop under a test runner.
 */

/**
 * Transient failures are retried twice with backoff before the task fails.
 * `MAX_JOB_ATTEMPTS` comes from `jobs/queue` rather than a local copy: the
 * dashboard renders "attempt N of {MAX_JOB_ATTEMPTS}" from that same export,
 * and two constants would let the copy and the actual give-up point drift.
 */
const RETRY_BACKOFF_MS = [5_000, 20_000];

export type Logger = (level: "info" | "warn" | "error", message: string) => void;

/** Decides whether a failed job is retried or the task is failed outright. */
export function handleJobFailure(job: JobRow, error: unknown, log: Logger): void {
  const message = error instanceof Error ? error.message : String(error);
  const retryable =
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable: unknown }).retryable === false
      ? false
      : true;

  const canRetry = retryable && job.attempts < MAX_JOB_ATTEMPTS;

  if (canRetry) {
    const backoff = RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    log("warn", `Job ${job.id} failed (attempt ${job.attempts}), retrying in ${backoff}ms: ${message}`);
    appendEvent(job.taskId, null, {
      type: "log",
      level: "warn",
      message: `Stage failed, retrying: ${message}`,
    });
    failJob(job.id, message, Date.now() + backoff);
    return;
  }

  const run =
    job.kind === "cleanup_workspace" || job.kind === "quota_wake"
      ? null
      : getStageRun(parsePayload<{ stageRunId?: string }>(job).stageRunId ?? "");

  // A cancellation is not a failure: `execute.ts` already marked the run
  // "cancelled" (with its partial cost, per the S1 fix) before throwing, and
  // `cancelTask` already drove the task to `CANCELLED` before the abort
  // landed — nothing here should re-mark it failed, log a spurious
  // `stage_failed`, or advance the task a second time (§6.5).
  if (run?.status === "cancelled") {
    log("info", `Job ${job.id} was cancelled.`);
    failJob(job.id, message);
    return;
  }

  log("error", `Job ${job.id} failed permanently: ${message}`);
  failJob(job.id, message);

  const failureKind = error instanceof StageJobError ? error.kind : undefined;

  if (run) {
    // Some failures (workspace preparation, a missing input artifact) escape
    // before the stage marks itself failed, which would leave the row stuck on
    // `running` and the timeline showing a stage that never ends.
    if (run.status !== "failed") {
      markStageRunStatus(run.id, "failed", { error: message });
    }
    appendEvent(job.taskId, run.id, {
      type: "stage_failed",
      stage: run.stage,
      attempt: run.attempt,
      error: message,
    });
  }

  // A cleanup or quota-wake failure must not take a task down — neither is
  // that task's own stage run (quota_wake's `taskId` is just whichever park
  // triggered it, per `db/schema.ts`'s `JOB_KINDS` comment).
  if (job.kind !== "cleanup_workspace" && job.kind !== "quota_wake" && taskIsActive(job.taskId)) {
    try {
      advanceTask(job.taskId, {
        kind: "stage_failed",
        stage: run?.stage ?? "CREATED",
        error: message,
        failureKind,
      });
    } catch (transitionError) {
      log("error", `Could not fail task ${job.taskId}: ${String(transitionError)}`);
    }
  }
}
