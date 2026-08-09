import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * stories.md S1 — `usageByStage` used to accept no time window at all, which
 * is why the Costs page hardcoded "By stage (all time)" beside a 7/30/90-day
 * selector that only affected the by-task table. This covers the added
 * `windowDays` parameter and the "under-reported tokens" marker `costPerTask`
 * now carries.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-by-stage-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
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

/** Inserts a finished DEVELOPMENT stage run, backdated to `createdAtMs`. */
function seedRun(costUsd: number, createdAtMs: number) {
  const task = service.createTask({
    repoId,
    title: "A task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
  service.updateStageRun(run.id, {
    status: "done",
    createdAt: createdAtMs,
    startedAt: createdAtMs,
    finishedAt: createdAtMs,
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
  });
  return { task, run };
}

describe("usageByStage", () => {
  it("without a window, behaves exactly as before — every run counted", () => {
    seedRun(1, Date.now() - 40 * 24 * 60 * 60 * 1000);
    seedRun(2, Date.now());

    const rows = service.usageByStage();
    const development = rows.find((row) => row.stage === "DEVELOPMENT");
    expect(development?.runs).toBe(2);
    expect(development?.costUsd).toBeCloseTo(3, 10);
  });

  it("with a window, excludes runs outside it", () => {
    seedRun(1, Date.now() - 40 * 24 * 60 * 60 * 1000);
    seedRun(2, Date.now());

    const rows = service.usageByStage(undefined, 7);
    const development = rows.find((row) => row.stage === "DEVELOPMENT");
    expect(development?.runs).toBe(1);
    expect(development?.costUsd).toBeCloseTo(2, 10);
  });
});

describe("costPerTask — under-reported tokens marker", () => {
  it("flags a task whose only stage run predates the cache-token fix cutoff", () => {
    // The migration writes the cutoff at process start (well before this test
    // runs); backdating the run to the epoch guarantees it predates it.
    const { task } = seedRun(1, 0);

    const rows = service.costPerTask();
    const row = rows.find((r) => r.taskId === task.id);
    expect(row?.hasUnderReportedTokens).toBe(true);
  });

  it("does not flag a task whose stage runs were all written after the cutoff", () => {
    const { task } = seedRun(1, Date.now());

    const rows = service.costPerTask();
    const row = rows.find((r) => r.taskId === task.id);
    expect(row?.hasUnderReportedTokens).toBe(false);
  });
});
