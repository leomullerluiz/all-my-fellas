import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Job claim ordering: highest priority first, lowest estimated complexity as
 * the tiebreaker, then FIFO — see `spec-task-queue.md` §9.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ordering-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let queue: typeof import("@/server/jobs/queue");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  queue = await import("@/server/jobs/queue");

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

/** Creates a task with a queued job, without going through the pipeline. */
function queueTask(
  title: string,
  priority: Priority,
  difficulty: "S" | "M" | "L" | null = null,
) {
  const task = service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority,
  });
  if (difficulty) service.setTaskEstimate(task.id, difficulty, null);
  queue.enqueueJob({ taskId: task.id, kind: "run_stage", payload: {} });
  return task;
}

/** Claims every eligible job and returns the task titles in claim order. */
function claimOrder(limit = 99): string[] {
  const titles: string[] = [];
  for (;;) {
    const job = queue.claimNextJob(limit);
    if (!job) break;
    titles.push(service.getTask(job.taskId)!.title);
    queue.completeJob(job.id);
  }
  return titles;
}

describe("claimNextJob ordering", () => {
  it("claims the highest priority first", () => {
    queueTask("low", "low");
    queueTask("urgent", "urgent");
    queueTask("medium", "medium");
    queueTask("high", "high");

    expect(claimOrder()).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("breaks equal priority by lowest complexity", () => {
    queueTask("large", "high", "L");
    queueTask("small", "high", "S");
    queueTask("medium", "high", "M");

    expect(claimOrder()).toEqual(["small", "medium", "large"]);
  });

  it("treats an unestimated task as medium complexity, not last", () => {
    queueTask("large", "high", "L");
    queueTask("unestimated", "high", null);
    queueTask("small", "high", "S");

    expect(claimOrder()).toEqual(["small", "unestimated", "large"]);
  });

  it("falls back to FIFO when priority and complexity match", () => {
    queueTask("first", "medium", "M");
    queueTask("second", "medium", "M");
    queueTask("third", "medium", "M");

    expect(claimOrder()).toEqual(["first", "second", "third"]);
  });

  it("puts priority ahead of complexity", () => {
    // A large urgent task still beats a small low-priority one.
    queueTask("small but low", "low", "S");
    queueTask("large but urgent", "urgent", "L");

    expect(claimOrder()).toEqual(["large but urgent", "small but low"]);
  });

  it("still respects the parallelism cap while ordering", () => {
    queueTask("urgent", "urgent");
    queueTask("low", "low");

    const first = queue.claimNextJob(1);
    expect(service.getTask(first!.taskId)!.title).toBe("urgent");

    // One task already holds a claimed job, so the cap blocks the second.
    expect(queue.claimNextJob(1)).toBeNull();
  });
});
