import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `bumpToFrontOfQueue` — S7 §8.3's "Run this next". Sets `updated_at` older
 * than every other queued task's, so the task sorts first among ties on
 * priority and difficulty — not a bump to `Date.now()`, which would sort it
 * *last* among ties (`techplan.md`'s explicit call-out).
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-to-front-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let settings: typeof import("@/server/settings/store");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  orchestrator = await import("@/server/pipeline/orchestrator");
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
  for (const task of service.listTasks({ includeArchived: true })) service.deleteTask(task.id);
  settings.updateSettings({ maxParallelTasks: 1 });
});

function queue(title: string, priority: "low" | "medium" | "high" | "urgent" = "medium") {
  const task = service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority,
  });
  service.updateTask(task.id, { status: "on_queue" });
  return task;
}

describe("bumpToFrontOfQueue", () => {
  it("sorts the bumped task ahead of every other queued task tied on priority and difficulty", () => {
    queue("Queued first");
    queue("Queued second");
    const third = queue("Queued third — bump this one");

    orchestrator.bumpToFrontOfQueue(third.id);

    const order = [...service.queuedTasks()]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((t) => t.title);
    expect(order[0]).toBe("Queued third — bump this one");
    expect(order).toEqual(["Queued third — bump this one", "Queued first", "Queued second"]);
  });

  it("does not let a bumped lower-priority task jump ahead of a higher-priority one", () => {
    const bumped = queue("Bumped, medium priority");
    const urgent = queue("Never bumped, urgent", "urgent");
    orchestrator.bumpToFrontOfQueue(bumped.id);

    // Priority still wins over the queue-time tiebreak `updated_at` drives —
    // bumping only reorders "next among equals" (§8.3), not the priority
    // ranking itself. `promoteQueue` (called here via a slot-freeing
    // cancellation, its only real trigger) still resumes the urgent task
    // first despite the medium-priority one being bumped.
    const holder = service.createTask({
      repoId,
      title: "Holds the only slot",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(holder.id);
    orchestrator.cancelTask(holder.id);

    expect(service.getTask(urgent.id)!.status).toBe("running");
    expect(service.getTask(bumped.id)!.status).toBe("on_queue");
  });

  it("is a no-op for a task that is not currently queued", () => {
    const running = service.createTask({
      repoId,
      title: "Already running",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(running.id);
    const before = service.getTask(running.id)!.updatedAt;

    orchestrator.bumpToFrontOfQueue(running.id);

    expect(service.getTask(running.id)!.updatedAt).toBe(before);
  });

  it("throws TaskNotFoundError for an unknown id", () => {
    expect(() => orchestrator.bumpToFrontOfQueue("task_missing")).toThrow(
      orchestrator.TaskNotFoundError,
    );
  });
});
