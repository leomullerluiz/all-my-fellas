import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * stories.md S5/S8.2 — `dailySpend` buckets by local calendar day
 * (`date(started_at/1000, 'unixepoch', 'localtime')`), the same local-time
 * convention `quota.ts`'s `periodStart` deliberately uses — a chart bucketed
 * by UTC beside a quota bar reset at local midnight would disagree by up to a
 * day at the boundary.
 *
 * Deliberately does not force `process.env.TZ`: SQLite's own `'localtime'`
 * modifier (via better-sqlite3's native binding) reads the OS's actual
 * timezone rather than the Node process's `TZ` variable on every platform,
 * so pinning `TZ` here would make the JS-computed boundaries below disagree
 * with what the SQL query actually buckets by. Using the host's real local
 * time keeps both sides of the comparison consistent.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-spend-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let quota: typeof import("@/server/usage/quota");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  quota = await import("@/server/usage/quota");
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

function seedRun(costUsd: number, startedAtMs: number) {
  const task = service.createTask({
    repoId,
    title: "A task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
  service.updateStageRun(run.id, { status: "done", startedAt: startedAtMs, finishedAt: startedAtMs, costUsd });
}

describe("dailySpend", () => {
  it("buckets two runs on the same local day into one row", () => {
    const now = new Date(2025, 5, 15, 9, 0, 0).getTime();
    seedRun(1, now);
    seedRun(2, new Date(2025, 5, 15, 20, 0, 0).getTime());

    const rows = service.dailySpend({});
    expect(rows.length).toBe(1);
    expect(rows[0].costUsd).toBeCloseTo(3, 10);
  });

  it("splits runs either side of local midnight into two rows", () => {
    const midnight = quota.periodStart("daily", new Date(2025, 5, 15, 12, 0, 0).getTime());
    seedRun(5, midnight - 60_000); // 23:59 the day before
    seedRun(7, midnight + 60_000); // 00:01 the new day

    const rows = service.dailySpend({});
    expect(rows.length).toBe(2);
    const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
    expect(total).toBeCloseTo(12, 10);
  });

  it("excludes days outside the requested window", () => {
    seedRun(1, Date.now() - 40 * 24 * 60 * 60 * 1000);
    seedRun(2, Date.now());

    const rows = service.dailySpend({ days: 7 });
    expect(rows.length).toBe(1);
    expect(rows[0].costUsd).toBeCloseTo(2, 10);
  });

  it("is empty when nothing has run", () => {
    expect(service.dailySpend({})).toEqual([]);
  });
});
