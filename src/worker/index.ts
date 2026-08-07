import "dotenv/config";

import { hasGithubToken, resolveProviderAuth } from "../server/config/env";
import { closeDatabase } from "../server/db/client";
import { appendEvent } from "../server/events/store";
import {
  claimNextJob,
  completeJob,
  failJob,
  parsePayload,
  requeueOrphanedJobs,
  taskIsActive,
} from "../server/jobs/queue";
import {
  executeAgentStage,
  executeCleanup,
  executeDelivery,
  executeVerification,
} from "../server/pipeline/execute";
import { advanceTask } from "../server/pipeline/orchestrator";
import { runMaintenanceSweep } from "../server/pipeline/audit/retention";
import { getSettings } from "../server/settings/store";
import type { JobRow } from "../server/db/schema";
import { getStageRun, markStageRunStatus } from "../server/tasks/service";

/**
 * The pipeline worker.
 *
 * A single long-running Node process that drains the job queue. Agent sessions
 * take minutes and stream continuously, which is exactly what a Next.js
 * request/response cycle cannot host — hence the separate process.
 */

const TICK_MS = 1_000;
/** Transient failures are retried twice with backoff before the task fails. */
const MAX_JOB_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [5_000, 20_000];
/** How often the transcript retention sweep runs, beyond the one at startup. */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

let shuttingDown = false;
let activeJob: JobRow | null = null;
let nextMaintenanceAt = 0;

function log(level: "info" | "warn" | "error", message: string): void {
  const stamp = new Date().toISOString();
  const line = `[worker ${stamp}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function banner(): void {
  const auth = resolveProviderAuth();
  const settings = getSettings();

  log("info", `Claude auth mode: ${auth.label}`);
  if (auth.mode === "missing") {
    log(
      "warn",
      "No Claude credential found — agent stages will fail. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.",
    );
  }
  if (!hasGithubToken()) {
    log("warn", "GITHUB_TOKEN is not set — cloning private repos and delivery will fail.");
  }
  log(
    "info",
    `Limits: ${settings.maxParallelTasks} parallel task(s), ${settings.reworkMaxCycles} rework cycle(s).`,
  );
}

async function handleJob(job: JobRow): Promise<void> {
  switch (job.kind) {
    case "run_stage": {
      const { stageRunId } = parsePayload<{ stageRunId: string }>(job);
      await executeAgentStage(stageRunId);
      break;
    }
    case "deliver": {
      const { stageRunId } = parsePayload<{ stageRunId: string }>(job);
      await executeDelivery(stageRunId);
      break;
    }
    case "verify": {
      const { stageRunId } = parsePayload<{ stageRunId: string }>(job);
      await executeVerification(stageRunId);
      break;
    }
    case "cleanup_workspace": {
      await executeCleanup(job.taskId);
      break;
    }
    default: {
      // A job kind added to `JOB_KINDS` without a case here used to complete
      // silently — the job finished, nothing ran, and the task hung on its
      // stage forever. Throwing turns that into a loud, retried failure.
      const unreachable: never = job.kind;
      throw new Error(`No handler for job kind "${unreachable}".`);
    }
  }
}

/** Decides whether a failed job is retried or the task is failed outright. */
function handleJobFailure(job: JobRow, error: unknown): void {
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

  log("error", `Job ${job.id} failed permanently: ${message}`);
  failJob(job.id, message);

  const run =
    job.kind === "cleanup_workspace"
      ? null
      : getStageRun(parsePayload<{ stageRunId?: string }>(job).stageRunId ?? "");

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

  // A cleanup failure must not take the whole task down — it already finished.
  if (job.kind !== "cleanup_workspace" && taskIsActive(job.taskId)) {
    try {
      advanceTask(job.taskId, {
        kind: "stage_failed",
        stage: run?.stage ?? "CREATED",
        error: message,
      });
    } catch (transitionError) {
      log("error", `Could not fail task ${job.taskId}: ${String(transitionError)}`);
    }
  }
}

/**
 * Runs the transcript retention sweep (§11) if it is due, and schedules the
 * next one. Called between jobs, not concurrently with one — a multi-megabyte
 * `UPDATE` has no business racing an active agent stage.
 */
function runMaintenanceIfDue(): void {
  const now = Date.now();
  if (now < nextMaintenanceAt) return;
  nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS;

  try {
    const { swept } = runMaintenanceSweep();
    if (swept > 0) log("info", `Transcript retention sweep pruned ${swept} run(s).`);
  } catch (error) {
    log("error", `Transcript retention sweep failed: ${String(error)}`);
  }
}

async function tick(): Promise<void> {
  const { maxParallelTasks } = getSettings();
  const job = claimNextJob(maxParallelTasks);
  if (!job) return;

  activeJob = job;

  // A task cancelled while the job sat in the queue should not start now.
  if (job.kind !== "cleanup_workspace" && !taskIsActive(job.taskId)) {
    log("info", `Skipping job ${job.id}: task ${job.taskId} is no longer active.`);
    completeJob(job.id);
    activeJob = null;
    return;
  }

  log("info", `Running job ${job.id} (${job.kind}) for task ${job.taskId}`);

  try {
    await handleJob(job);
    completeJob(job.id);
    log("info", `Job ${job.id} done.`);
  } catch (error) {
    handleJobFailure(job, error);
  } finally {
    activeJob = null;
  }
}

async function main(): Promise<void> {
  banner();

  const requeued = requeueOrphanedJobs();
  if (requeued > 0) log("info", `Requeued ${requeued} job(s) left claimed by a previous run.`);

  // Once at startup, next to `requeueOrphanedJobs` — the worker already owns
  // long-running maintenance at boot. `runMaintenanceIfDue` schedules the next
  // run itself, so this also sets `nextMaintenanceAt` for the loop below.
  runMaintenanceIfDue();

  log("info", "Worker ready.");

  while (!shuttingDown) {
    try {
      await tick();
      runMaintenanceIfDue();
    } catch (error) {
      log("error", `Unexpected error in worker loop: ${String(error)}`);
    }
    if (!shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }
  }

  closeDatabase();
  log("info", "Worker stopped.");
}

/**
 * Graceful shutdown: stop claiming new work and let the current job finish.
 * The loop checks `shuttingDown` between jobs, and `tick()` already awaits the
 * active job, so no additional coordination is needed.
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Received ${signal}. Finishing the current job before exiting…`);
  if (activeJob) log("info", `Waiting on job ${activeJob.id}.`);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  log("error", `Worker crashed: ${String(error)}`);
  process.exitCode = 1;
});
