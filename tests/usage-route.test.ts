import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `GET /api/usage?days=N` — stories.md S1's regression test for the window-unit
 * bug: the route used to compute a millisecond cutoff and pass it to
 * `costPerTask(windowDays)`, whose parameter is a *day count*. A timestamp near
 * `1.77e12` multiplied by `86_400_000` produced a cutoff near `-1.5e20`, so every
 * row passed regardless of `days`. This test fails against that code.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-route-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let usageRoute: typeof import("@/app/api/usage/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  usageRoute = await import("@/app/api/usage/route");

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

/** Creates a task, then rewrites its `createdAt` to `createdAtMs` directly. */
function seedTaskCreatedAt(createdAtMs: number) {
  const task = service.createTask({
    repoId,
    title: "An old task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  service.updateTask(task.id, { createdAt: createdAtMs });
  return task;
}

describe("GET /api/usage?days=", () => {
  it("excludes a task created 30 days ago when days=7", async () => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    seedTaskCreatedAt(thirtyDaysAgo);
    const recent = service.createTask({
      repoId,
      title: "A recent task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    const response = await usageRoute.GET(new Request("http://test/api/usage?days=7"));
    const body = (await response.json()) as { byTask: Array<{ taskId: string }> };

    const taskIds = body.byTask.map((row) => row.taskId);
    expect(taskIds).toContain(recent.id);
    expect(taskIds.length).toBe(1);
  });

  it("returns every task when no days filter is given", async () => {
    seedTaskCreatedAt(Date.now() - 30 * 24 * 60 * 60 * 1000);
    service.createTask({
      repoId,
      title: "A recent task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    const response = await usageRoute.GET(new Request("http://test/api/usage"));
    const body = (await response.json()) as { byTask: Array<{ taskId: string }> };
    expect(body.byTask.length).toBe(2);
  });
});
