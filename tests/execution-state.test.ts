import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `executionStates()` — the derivation behind S1/S2's honest per-card
 * indicator. Fixtures write `tasks`/`jobs` rows directly (via `updateTask` and
 * `enqueueJob`) rather than through the pipeline, so every branch — including
 * ones the real pipeline rarely produces, like `settling` — is reachable
 * without a real agent run.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-state-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let queue: typeof import("@/server/jobs/queue");
let execution: typeof import("@/server/pipeline/execution");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  queue = await import("@/server/jobs/queue");
  execution = await import("@/server/pipeline/execution");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const task of service.listTasks()) service.deleteTask(task.id);
});

type Priority = "low" | "medium" | "high" | "urgent";

/** Creates a task and forces it directly to `status`, bypassing the pipeline. */
function makeTask(title: string, status: string, priority: Priority = "medium") {
  const task = service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority,
  });
  service.updateTask(task.id, { status: status as never });
  return task;
}

describe("executionStates", () => {
  it("marks a task with a claimed run_stage job in_flight (agent)", () => {
    const task = makeTask("Developing", "running");
    queue.enqueueJob({ taskId: task.id, kind: "run_stage" });
    queue.claimNextJob(99);

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "in_flight", job: "agent" });
  });

  it("marks a task with a claimed deliver job in_flight (delivery)", () => {
    const task = makeTask("Delivering", "running");
    queue.enqueueJob({ taskId: task.id, kind: "deliver" });
    queue.claimNextJob(99);

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "in_flight", job: "delivery" });
  });

  it("marks a task with a claimed verify job in_flight (verification)", () => {
    const task = makeTask("Verifying", "running");
    queue.enqueueJob({ taskId: task.id, kind: "verify" });
    queue.claimNextJob(99);

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "in_flight", job: "verification" });
  });

  it("marks an admitted task with only an eligible pending job waiting_for_worker", () => {
    const task = makeTask("Waiting", "running");
    queue.enqueueJob({ taskId: task.id, kind: "run_stage" });

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "waiting_for_worker", position: 1, depth: 1 });
  });

  it("computes contiguous 1-based positions over a mixed-priority queue", () => {
    const urgent = makeTask("Urgent", "running", "urgent");
    const high = makeTask("High", "running", "high");
    const low = makeTask("Low", "running", "low");
    queue.enqueueJob({ taskId: low.id, kind: "run_stage" });
    queue.enqueueJob({ taskId: urgent.id, kind: "run_stage" });
    queue.enqueueJob({ taskId: high.id, kind: "run_stage" });

    const states = execution.executionStates();
    expect(states.get(urgent.id)).toEqual({ kind: "waiting_for_worker", position: 1, depth: 3 });
    expect(states.get(high.id)).toEqual({ kind: "waiting_for_worker", position: 2, depth: 3 });
    expect(states.get(low.id)).toEqual({ kind: "waiting_for_worker", position: 3, depth: 3 });
  });

  it("does not let an in-flight task's own pending job count toward the queue", () => {
    // The ordinary window between `advanceTask` scheduling the next stage and
    // `completeJob` marking the finished one done: a task can briefly hold a
    // claimed job and a pending one at the same time.
    const inFlight = makeTask("Running now", "running");
    const waiting = makeTask("Waiting", "running");
    queue.enqueueJob({ taskId: inFlight.id, kind: "run_stage" });
    queue.claimNextJob(99); // claims `inFlight`'s job
    queue.enqueueJob({ taskId: inFlight.id, kind: "deliver" }); // next stage, already scheduled
    queue.enqueueJob({ taskId: waiting.id, kind: "run_stage" });

    const states = execution.executionStates();
    expect(states.get(inFlight.id)).toEqual({ kind: "in_flight", job: "agent" });
    // Only `waiting` is in the queue: `inFlight`'s pending `deliver` job does
    // not push `waiting` down or inflate its own depth.
    expect(states.get(waiting.id)).toEqual({ kind: "waiting_for_worker", position: 1, depth: 1 });
  });

  it("excludes a claimed cleanup_workspace job from in_flight (§6.1 regression)", () => {
    const task = makeTask("Finished", "completed");
    queue.enqueueJob({ taskId: task.id, kind: "cleanup_workspace" });
    queue.claimNextJob(99);

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "idle" });
  });

  it("excludes an eligible cleanup_workspace job from another task's depth", () => {
    const waiting = makeTask("Waiting", "running");
    const finished = makeTask("Finished", "completed");
    queue.enqueueJob({ taskId: waiting.id, kind: "run_stage" });
    queue.enqueueJob({ taskId: finished.id, kind: "cleanup_workspace" });

    const state = execution.executionStateFor(waiting.id, execution.executionStates());
    expect(state).toEqual({ kind: "waiting_for_worker", position: 1, depth: 1 });
  });

  it("marks a pending job with a future runAfter retry_backoff, not waiting_for_worker", () => {
    const backoff = makeTask("Backing off", "running");
    const waiting = makeTask("Waiting", "running");
    queue.enqueueJob({ taskId: backoff.id, kind: "run_stage", runAfter: Date.now() + 60_000 });
    queue.enqueueJob({ taskId: waiting.id, kind: "run_stage" });

    const states = execution.executionStates();
    expect(states.get(backoff.id)?.kind).toBe("retry_backoff");
    // The backed-off task is excluded from every other task's depth.
    expect(states.get(waiting.id)).toEqual({ kind: "waiting_for_worker", position: 1, depth: 1 });
  });

  it("reports the retry's retryAt and attempt count", () => {
    const task = makeTask("Backing off", "running");
    const jobId = queue.enqueueJob({ taskId: task.id, kind: "run_stage" });
    queue.claimNextJob(99); // attempts: 0 -> 1
    const retryAt = Date.now() + 20_000;
    queue.failJob(jobId, "transient failure", retryAt);

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "retry_backoff", retryAt, attempt: 1 });
  });

  it("renders settling for a running task whose only job is failed", () => {
    // Exactly what `handleJobFailure` leaves behind when `advanceTask` itself
    // throws (worker/index.ts) — not a "between stages" fixture, which the
    // pipeline never produces (a stage always enqueues its successor before
    // marking itself done).
    const task = makeTask("Stranded", "running");
    const jobId = queue.enqueueJob({ taskId: task.id, kind: "run_stage" });
    queue.claimNextJob(99);
    queue.failJob(jobId, "boom"); // no retryAfter: terminal failure

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "settling" });
  });

  it("renders idle for a non-admitted task regardless of stray job rows", () => {
    const task = makeTask("Not started", "queued");

    const state = execution.executionStateFor(task.id, execution.executionStates());
    expect(state).toEqual({ kind: "idle" });
  });
});
