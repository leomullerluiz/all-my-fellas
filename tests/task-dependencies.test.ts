import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Service-level dependency plumbing: `replaceDependencies`,
 * `incompleteDependencies`, `wouldCreateCycle` — S1/S2 of `dependencias`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-dependencies-test-"));
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

describe("createTask with dependsOn", () => {
  it("creates a task with zero dependencies, unaffected", () => {
    const task = create("No deps");
    expect(service.listDependencies(task.id)).toEqual([]);
    expect(service.incompleteDependencies(task.id)).toEqual([]);
  });

  it("persists dependsOn in the same transaction as the task row", () => {
    const prereq = create("Prereq");
    const task = service.createTask({
      repoId,
      title: "Depends on prereq",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
      dependsOn: [prereq.id],
    });

    const deps = service.listDependencies(task.id);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ id: prereq.id, title: "Prereq" });
  });
});

describe("replaceDependencies", () => {
  it("replaces the stored set rather than appending", () => {
    const a = create("A");
    const b = create("B");
    const task = create("Task");

    service.replaceDependencies(task.id, [a.id]);
    expect(service.listDependencies(task.id).map((d) => d.id)).toEqual([a.id]);

    service.replaceDependencies(task.id, [b.id]);
    expect(service.listDependencies(task.id).map((d) => d.id)).toEqual([b.id]);
  });

  it("clears every dependency when given an empty array", () => {
    const a = create("A");
    const task = create("Task");
    service.replaceDependencies(task.id, [a.id]);

    service.replaceDependencies(task.id, []);
    expect(service.listDependencies(task.id)).toEqual([]);
  });
});

describe("incompleteDependencies", () => {
  it("treats COMPLETED as the only complete state", () => {
    const prereq = create("Prereq");
    const task = create("Task");
    service.replaceDependencies(task.id, [prereq.id]);

    expect(service.incompleteDependencies(task.id).map((d) => d.id)).toEqual([prereq.id]);

    service.setTaskStage(prereq.id, "COMPLETED");
    expect(service.incompleteDependencies(task.id)).toEqual([]);
  });

  it("keeps a FAILED prerequisite blocking — no silent skip", () => {
    const prereq = create("Prereq");
    const task = create("Task");
    service.replaceDependencies(task.id, [prereq.id]);

    service.setTaskStage(prereq.id, "FAILED");
    expect(service.incompleteDependencies(task.id).map((d) => d.id)).toEqual([prereq.id]);
  });

  it("keeps a CANCELLED prerequisite blocking — no silent skip", () => {
    const prereq = create("Prereq");
    const task = create("Task");
    service.replaceDependencies(task.id, [prereq.id]);

    service.setTaskStage(prereq.id, "CANCELLED");
    expect(service.incompleteDependencies(task.id).map((d) => d.id)).toEqual([prereq.id]);
  });
});

describe("wouldCreateCycle", () => {
  it("detects a direct two-hop cycle (A -> B, B -> A)", () => {
    const a = create("A");
    const b = create("B");
    service.replaceDependencies(a.id, [b.id]);

    expect(service.wouldCreateCycle(b.id, [a.id])).toBe(true);
  });

  it("detects a transitive cycle (A -> B -> C -> A)", () => {
    const a = create("A");
    const b = create("B");
    const c = create("C");
    service.replaceDependencies(b.id, [a.id]);
    service.replaceDependencies(c.id, [b.id]);

    expect(service.wouldCreateCycle(a.id, [c.id])).toBe(true);
  });

  it("allows a valid chain with no cycle", () => {
    const a = create("A");
    const b = create("B");

    expect(service.wouldCreateCycle(b.id, [a.id])).toBe(false);
  });
});
