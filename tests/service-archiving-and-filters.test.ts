import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * S2 §4.2's server-side `listTasks` filters and S3's archiving —
 * `spec-board-at-scale.md` §5.2's cost invariant in particular: archiving
 * must never make spend disappear from an aggregate.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-archiving-test-"));
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
  for (const task of service.listTasks({ includeArchived: true })) service.deleteTask(task.id);
});

function create(overrides: Partial<Parameters<typeof service.createTask>[0]> = {}, repo = repoId) {
  return service.createTask({
    repoId: repo,
    title: "A task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
    ...overrides,
  });
}

describe("listTasks structured filters", () => {
  it("q matches title and description, case-insensitively", () => {
    const byTitle = create({ title: "Refactor billing", description: "unrelated text" });
    const byDescription = create({ title: "Something else", description: "billing cleanup" });
    const neither = create({ title: "Nothing to do with it", description: "also nothing" });

    const ids = service.listTasks({ q: "BILLING" }).map((t) => t.id);
    expect(ids).toContain(byTitle.id);
    expect(ids).toContain(byDescription.id);
    expect(ids).not.toContain(neither.id);
  });

  it("repoId narrows to one repository", () => {
    const mine = create({ title: "Mine" });
    const theirs = create({ title: "Theirs" }, otherRepoId);

    const ids = service.listTasks({ repoId }).map((t) => t.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("priority and status compose with AND", () => {
    const match = create({ title: "Match", priority: "high" });
    const wrongPriority = create({ title: "Wrong priority", priority: "low" });

    const ids = service.listTasks({ priority: "high", status: "queued" }).map((t) => t.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(wrongPriority.id);
  });
});

describe("archiving", () => {
  it("archiveTask hides a task from the default listTasks() result; unarchive restores it", () => {
    const task = create({ title: "Old experiment" });
    expect(service.listTasks().map((t) => t.id)).toContain(task.id);

    service.archiveTask(task.id);
    expect(service.listTasks().map((t) => t.id)).not.toContain(task.id);
    expect(service.listTasks({ includeArchived: true }).map((t) => t.id)).toContain(task.id);

    service.unarchiveTask(task.id);
    expect(service.listTasks().map((t) => t.id)).toContain(task.id);
  });

  it("archiving a task with recorded cost does not change the aggregate spend total", () => {
    const task = create({ title: "Costly task" });
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.updateStageRun(run.id, { costUsd: 4.2 });

    const before = service.costByTaskId().get(task.id) ?? 0;
    expect(before).toBeCloseTo(4.2);

    service.archiveTask(task.id);

    // `costByTaskId`/`totalCostForTask` read `stage_runs` directly, with no
    // `archivedAt` predicate — see `spec-board-at-scale.md` §5.2: archiving
    // is not un-spending.
    expect(service.costByTaskId().get(task.id) ?? 0).toBeCloseTo(before);
    expect(service.totalCostForTask(task.id)).toBeCloseTo(before);
  });
});
