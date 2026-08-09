import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `GET /api/usage/export` — stories.md S5's CSV route, exercised the same way
 * `tests/usage-route.test.ts` exercises `GET /api/usage`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-export-route-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let exportRoute: typeof import("@/app/api/usage/export/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  exportRoute = await import("@/app/api/usage/export/route");
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

describe("GET /api/usage/export", () => {
  it("streams a CSV with a Content-Disposition attachment header", async () => {
    const task = service.createTask({
      repoId,
      title: "A task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });

    const response = await exportRoute.GET(new Request("http://test/api/usage/export"));
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");

    const body = await response.text();
    expect(body.split("\r\n")[0]).toContain("task_id,task_title");
    expect(body).toContain(task.id);
  });

  it("rejects an invalid days value", async () => {
    const response = await exportRoute.GET(new Request("http://test/api/usage/export?days=0"));
    expect(response.status).toBe(400);
  });
});
