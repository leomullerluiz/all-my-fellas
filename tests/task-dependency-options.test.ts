import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `listDependencyOptions` — the query behind the "Depends on" picker on both
 * the create and edit forms. See stories S1/S2 of `depends-on`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-dependency-options-test-"));
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

function create(title: string) {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

describe("listDependencyOptions", () => {
  it("excludes a completed task", () => {
    const done = create("Already done");
    service.setTaskStage(done.id, "COMPLETED");
    const open = create("Still open");

    const options = service.listDependencyOptions().map((o) => o.id);
    expect(options).toContain(open.id);
    expect(options).not.toContain(done.id);
  });

  it("keeps every non-completed status selectable", () => {
    const stages = [
      "CREATED",
      "STAKEHOLDER_REFINEMENT",
      "PLAN_GATE",
      "REJECTED",
      "FAILED",
      "CANCELLED",
    ] as const;

    const ids = stages.map((stage) => {
      const task = create(`Task at ${stage}`);
      service.setTaskStage(task.id, stage);
      return task.id;
    });

    const options = service.listDependencyOptions().map((o) => o.id);
    for (const id of ids) expect(options).toContain(id);
  });

  it("excludes excludeId regardless of status", () => {
    const task = create("Editing this one");

    const options = service.listDependencyOptions(task.id).map((o) => o.id);
    expect(options).not.toContain(task.id);
  });

  it("returns id, title and repoName for a surviving candidate", () => {
    const task = create("Set up the schema");

    const options = service.listDependencyOptions();
    expect(options).toEqual([{ id: task.id, title: "Set up the schema", repoName: "acme/app" }]);
  });
});
