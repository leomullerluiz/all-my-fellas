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
let otherRepoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;

  otherRepoId = service.createRepo({
    name: "acme/other",
    url: "https://github.com/acme/other",
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

function create(title: string, repo = repoId) {
  return service.createTask({
    repoId: repo,
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

  it("keeps every in-flight stage selectable", () => {
    const stages = ["CREATED", "STAKEHOLDER_REFINEMENT", "PLAN_GATE"] as const;

    const ids = stages.map((stage) => {
      const task = create(`Task at ${stage}`);
      service.setTaskStage(task.id, stage);
      return task.id;
    });

    const options = service.listDependencyOptions().map((o) => o.id);
    for (const id of ids) expect(options).toContain(id);
  });

  // A terminal task never reaches COMPLETED, so `incompleteDependencies` would
  // block the dependent task forever — see spec-board-at-scale.md §5.3.
  it("excludes a task in a terminal stage", () => {
    const stages = ["REJECTED", "FAILED", "CANCELLED"] as const;

    const ids = stages.map((stage) => {
      const task = create(`Task at ${stage}`);
      service.setTaskStage(task.id, stage);
      return task.id;
    });

    const options = service.listDependencyOptions().map((o) => o.id);
    for (const id of ids) expect(options).not.toContain(id);
  });

  it("excludes excludeId regardless of status", () => {
    const task = create("Editing this one");

    const options = service.listDependencyOptions(task.id).map((o) => o.id);
    expect(options).not.toContain(task.id);
  });

  it("keeps only the given repo's tasks when repoId is passed", () => {
    const mine = create("Same repository");
    const theirs = create("Other repository", otherRepoId);

    const options = service.listDependencyOptions(undefined, repoId).map((o) => o.id);
    expect(options).toEqual([mine.id]);
    expect(options).not.toContain(theirs.id);
  });

  it("spans every repo when repoId is omitted or empty", () => {
    const mine = create("Same repository");
    const theirs = create("Other repository", otherRepoId);

    for (const options of [
      service.listDependencyOptions(),
      service.listDependencyOptions(undefined, ""),
    ]) {
      const ids = options.map((o) => o.id);
      expect(ids).toContain(mine.id);
      expect(ids).toContain(theirs.id);
    }
  });

  it("returns id, title, repoId and repoName for a surviving candidate", () => {
    const task = create("Set up the schema");

    const options = service.listDependencyOptions();
    expect(options).toEqual([
      { id: task.id, title: "Set up the schema", repoId, repoName: "acme/app" },
    ]);
  });
});
