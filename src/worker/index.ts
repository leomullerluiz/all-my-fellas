import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { hasGithubToken, resolveProviderAuth } from "../server/config/env";
import { closeDatabase } from "../server/db/client";
import { claimNextJob, completeJob, parsePayload, requeueOrphanedJobs, taskIsActive } from "../server/jobs/queue";
import {
  executeAgentStage,
  executeCleanup,
  executeDelivery,
  executeVerification,
} from "../server/pipeline/execute";
import { promoteQueue } from "../server/pipeline/orchestrator";
import { runMaintenanceSweep } from "../server/pipeline/audit/retention";
import { getSettings } from "../server/settings/store";
import type { JobRow } from "../server/db/schema";
import { recordWorkerHeartbeat, recordWorkerStarted } from "../server/worker/status";
import { handleJobFailure } from "./job-failure";

/**
 * The pipeline worker.
 *
 * A single long-running Node process that drains the job queue. Agent sessions
 * take minutes and stream continuously, which is exactly what a Next.js
 * request/response cycle cannot host — hence the separate process.
 */

const TICK_MS = 1_000;
/** How often the transcript retention sweep runs, beyond the one at startup. */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/**
 * How often, while a job is in flight, the worker (a) checks whether the
 * task it belongs to is still active and aborts the job's controller the
 * first time it is not (§6.3), and (b) refreshes the heartbeat row (§7.2) —
 * one interval serves both, rather than two independently-timed ones racing
 * the same SQLite file from the same process. The cost is one indexed
 * single-row read and one single-row write per interval per in-flight job,
 * against a saving measured in agent turns — see §13.3 for the open question
 * on whether the cancellation half of this is the right number.
 */
const IN_FLIGHT_POLL_MS = 2_000;

let shuttingDown = false;
let activeJob: JobRow | null = null;
let nextMaintenanceAt = 0;

/**
 * Best-effort version tag for the heartbeat row (§7.2) — `package.json`'s
 * version, read at runtime rather than imported, since the worker's own
 * `tsconfig.worker.json` roots compilation at `src/` and a static import of a
 * file outside it would fight that. Purely informational: a read failure
 * leaves the row's `version` `null`, which is not a health signal.
 */
function resolveVersion(): string | null {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

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

/**
 * @param abortController The controller `tick()` created for this job's
 *   lifetime (§6.2). Only `run_stage` actually consumes it — the other job
 *   kinds do not call `runStage`, so aborting them mid-flight would do
 *   nothing; they still get a controller for uniformity, at no cost.
 */
async function handleJob(job: JobRow, abortController: AbortController): Promise<void> {
  switch (job.kind) {
    case "run_stage": {
      const { stageRunId } = parsePayload<{ stageRunId: string }>(job);
      await executeAgentStage(stageRunId, abortController);
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
    case "quota_wake": {
      // Global by nature — re-checks every parked task, not just the one
      // this job happens to be attached to (§4.5).
      promoteQueue();
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
  if (!job) {
    // Written on every tick, not just while a job is in flight (§7.2) — an
    // idle worker is a healthy worker, and a heartbeat that only moved while
    // busy would read as "stale" the moment work runs dry.
    recordWorkerHeartbeat({ activeJobId: null, activeTaskId: null });
    return;
  }

  activeJob = job;

  // A task cancelled while the job sat in the queue should not start now.
  // `quota_wake`'s effect (`promoteQueue()`) is global, not scoped to the
  // task it happens to be attached to, so it runs regardless of that task's
  // own status.
  if (job.kind !== "cleanup_workspace" && job.kind !== "quota_wake" && !taskIsActive(job.taskId)) {
    log("info", `Skipping job ${job.id}: task ${job.taskId} is no longer active.`);
    completeJob(job.id);
    activeJob = null;
    recordWorkerHeartbeat({ activeJobId: null, activeTaskId: null });
    return;
  }

  log("info", `Running job ${job.id} (${job.kind}) for task ${job.taskId}`);
  recordWorkerHeartbeat({ activeJobId: job.id, activeTaskId: job.taskId });

  // One controller for this job's lifetime (§6.2), plus its own poll timer:
  // the tick loop itself is blocked inside `await handleJob` for the whole
  // duration of an agent session, so the cancellation check — and the
  // heartbeat refresh (§7.2) — need a timer independent of that loop, not
  // another pass through it.
  const abortController = new AbortController();
  const watch = setInterval(() => {
    if (!taskIsActive(job.taskId)) abortController.abort();
    recordWorkerHeartbeat({ activeJobId: job.id, activeTaskId: job.taskId });
  }, IN_FLIGHT_POLL_MS);

  try {
    await handleJob(job, abortController);
    completeJob(job.id);
    log("info", `Job ${job.id} done.`);
  } catch (error) {
    handleJobFailure(job, error, log);
  } finally {
    clearInterval(watch);
    activeJob = null;
    recordWorkerHeartbeat({ activeJobId: null, activeTaskId: null });
  }
}

async function main(): Promise<void> {
  banner();
  recordWorkerStarted({ pid: process.pid, version: resolveVersion() });

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
