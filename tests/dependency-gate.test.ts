import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The dependency gate: `startTask`, `startTasksBatch`, `promoteQueue`.
 *
 * The invariant this protects is `stories.md` S2: a task cannot start while
 * any of its prerequisites is not `COMPLETED`, and this check is independent
 * of — and checked before — admission control (`CapacityError`).
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-gate-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let orchestrator: typeof import("@/server/pipeline/orchestrator");
let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let repoId: string;

beforeAll(async () => {
  orchestrator = await import("@/server/pipeline/orchestrator");
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");

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
  settings.updateSettings({ maxParallelTasks: 5 });
});

function create(
  title: string,
  dependsOn: string[] = [],
  priority: "low" | "medium" | "high" | "urgent" = "medium",
) {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority,
    dependsOn,
  });
}

/** Parks `task` at `on_queue` the way `startTasksBatch` does on a refusal. */
function park(task: { id: string }) {
  service.updateTask(task.id, { status: "on_queue" });
}

describe("startTask", () => {
  it("starts a task with no dependencies, unaffected", () => {
    const task = create("No deps");
    expect(() => orchestrator.startTask(task.id)).not.toThrow();
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  it("starts once every prerequisite reaches COMPLETED", () => {
    const prereq = create("Prereq");
    service.setTaskStage(prereq.id, "COMPLETED");
    const task = create("Task", [prereq.id]);

    expect(() => orchestrator.startTask(task.id)).not.toThrow();
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  it("blocks while one prerequisite is incomplete", () => {
    const prereq = create("Prereq");
    const task = create("Task", [prereq.id]);

    expect(() => orchestrator.startTask(task.id)).toThrow(orchestrator.DependencyError);
    expect(service.getTask(task.id)!.currentStage).toBe("CREATED");
  });

  it("names the incomplete prerequisite in the error", () => {
    const prereq = create("Design the API");
    const task = create("Task", [prereq.id]);

    try {
      orchestrator.startTask(task.id);
      expect.unreachable("expected a DependencyError");
    } catch (error) {
      expect(error).toBeInstanceOf(orchestrator.DependencyError);
      const dependencyError = error as InstanceType<typeof orchestrator.DependencyError>;
      expect(dependencyError.message).toContain("Design the API");
      expect(dependencyError.incomplete.map((t) => t.id)).toEqual([prereq.id]);
    }
  });

  it("stays blocked when a prerequisite is FAILED — no silent skip", () => {
    const prereq = create("Prereq");
    service.setTaskStage(prereq.id, "FAILED");
    const task = create("Task", [prereq.id]);

    expect(() => orchestrator.startTask(task.id)).toThrow(orchestrator.DependencyError);
  });

  it("stays blocked when a prerequisite is CANCELLED — no silent skip", () => {
    const prereq = create("Prereq");
    service.setTaskStage(prereq.id, "CANCELLED");
    const task = create("Task", [prereq.id]);

    expect(() => orchestrator.startTask(task.id)).toThrow(orchestrator.DependencyError);
  });

  it("leaves the task's state untouched on a refused start", () => {
    const prereq = create("Prereq");
    const task = create("Task", [prereq.id]);

    expect(() => orchestrator.startTask(task.id)).toThrow();
    expect(service.listStageRuns(task.id)).toHaveLength(0);
    expect(service.getTask(task.id)!.currentStage).toBe("CREATED");
  });

  it("is independent of capacity: blocked by dependency even with a free slot", () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const prereq = create("Prereq");
    const task = create("Task", [prereq.id]);

    expect(orchestrator.capacity().slotAvailable).toBe(true);
    expect(() => orchestrator.startTask(task.id)).toThrow(orchestrator.DependencyError);
  });

  it("still enforces capacity once dependencies are clear", () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const prereq = create("Prereq");
    service.setTaskStage(prereq.id, "COMPLETED");
    const blocking = create("Blocking");
    orchestrator.startTask(blocking.id);

    const task = create("Task", [prereq.id]);
    expect(() => orchestrator.startTask(task.id)).toThrow(orchestrator.CapacityError);
  });
});

describe("startTasksBatch", () => {
  it("skips a dependency-blocked task, naming the prerequisite, and continues the batch", () => {
    const prereq = create("Prereq");
    const blocked = create("Blocked", [prereq.id]);
    const clear = create("Clear");

    const results = orchestrator.startTasksBatch([blocked.id, clear.id]);

    const blockedResult = results.find((r) => r.taskId === blocked.id)!;
    expect(blockedResult.started).toBe(false);
    expect(blockedResult.reason).toContain("Prereq");

    const clearResult = results.find((r) => r.taskId === clear.id)!;
    expect(clearResult.started).toBe(true);
    expect(service.getTask(clear.id)!.status).toBe("running");
  });
});

describe("promoteQueue", () => {
  it("skips a dependency-blocked on_queue task and starts the next eligible one", () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const active = create("Active");
    const prereq = create("Prereq");
    const blocked = create("Blocked", [prereq.id], "urgent");
    const eligible = create("Eligible", [], "low");

    orchestrator.startTask(active.id);
    park(blocked);
    park(eligible);

    orchestrator.cancelTask(active.id);

    // The higher-priority `blocked` task is skipped in favour of the next
    // eligible one, rather than leaving the freed slot idle.
    expect(service.getTask(blocked.id)!.status).toBe("on_queue");
    expect(service.getTask(eligible.id)!.status).toBe("running");
  });

  it("starts a previously blocked on_queue task once its prerequisite completes and a slot frees", () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const active = create("Active");
    const prereq = create("Prereq");
    const blocked = create("Blocked", [prereq.id]);

    orchestrator.startTask(active.id);
    park(blocked);

    orchestrator.cancelTask(active.id);
    expect(service.getTask(blocked.id)!.status).toBe("on_queue");

    // Prerequisite finishes; nothing re-checks the queue on its own (no
    // continuous re-validation), but the next slot-freeing transition does.
    service.setTaskStage(prereq.id, "COMPLETED");
    const other = create("Other");
    orchestrator.startTask(other.id);
    orchestrator.cancelTask(other.id);

    expect(service.getTask(blocked.id)!.status).toBe("running");
  });

  it("still stops at the first CapacityError rather than trying further candidates", () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const active = create("Active");
    const queued = create("Queued");
    orchestrator.startTask(active.id);
    park(queued);

    orchestrator.cancelTask(active.id);
    expect(service.getTask(queued.id)!.status).toBe("running");
  });
});
