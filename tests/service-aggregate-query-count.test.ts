import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S5 §9.1's N+1 fix — `costByTaskId`/`dependenciesByTaskId` replace one
 * `totalCostForTask`/`listDependencies` call per task with a single
 * `GROUP BY` each. This locks in both halves of AC1: the aggregate values
 * match the per-task functions exactly, and the number of SQL statements
 * issued does not grow with the number of tasks on the board.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-aggregate-query-count-test-"));
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

/** Seeds `count` tasks, each with a stage run (so cost is non-zero) and,
 * past the first, a dependency on the previous one (so dependsOn is
 * non-empty for most of the fixture). */
function seedTasks(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const task = service.createTask({
      repoId,
      title: `Task ${i}`,
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.updateStageRun(run.id, { costUsd: (i + 1) * 0.5 });
    if (i > 0) service.replaceDependencies(task.id, [ids[i - 1]]);
    ids.push(task.id);
  }
  return ids;
}

/** Counts `Database.prototype.prepare` calls made while running `fn` — the
 * one call every distinct SQL statement drizzle's better-sqlite3 driver goes
 * through, regardless of how many rows it returns. */
function countPrepares(fn: () => void): number {
  const spy = vi.spyOn(Database.prototype, "prepare");
  spy.mockClear();
  fn();
  const count = spy.mock.calls.length;
  spy.mockRestore();
  return count;
}

describe("costByTaskId / dependenciesByTaskId", () => {
  it("match the per-task functions exactly, over a 50-task fixture", () => {
    const ids = seedTasks(50);

    const costs = service.costByTaskId();
    const deps = service.dependenciesByTaskId();

    for (const id of ids) {
      expect(costs.get(id) ?? 0).toBeCloseTo(service.totalCostForTask(id));
      expect((deps.get(id) ?? []).map((d) => d.id).sort()).toEqual(
        service.listDependencies(id).map((d) => d.id).sort(),
      );
    }
  });

  it("issue a constant number of queries as task count grows, not one per task", () => {
    seedTasks(3);
    const smallCount = countPrepares(() => {
      service.costByTaskId();
      service.dependenciesByTaskId();
    });

    seedTasks(50);
    const largeCount = countPrepares(() => {
      service.costByTaskId();
      service.dependenciesByTaskId();
    });

    // Same number of statements for 3 tasks as for 53 — the aggregate
    // `GROUP BY` shape doesn't add a statement per row, unlike the
    // `totalCostForTask`/`listDependencies`-per-task loop it replaced.
    expect(largeCount).toBe(smallCount);
    expect(largeCount).toBeLessThan(10);
  });
});
