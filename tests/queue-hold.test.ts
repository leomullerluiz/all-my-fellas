import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * S6 — the global queue hold (§9.2): `claimNextJobUnlessHeld` is the exact
 * gate `worker/index.ts`'s `tick()` calls, split out so it is testable
 * without importing the worker entrypoint (which starts its real polling
 * loop unconditionally on import).
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-hold-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let orchestrator: typeof import("@/server/pipeline/orchestrator");
let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let queue: typeof import("@/server/jobs/queue");
let repoId: string;

beforeAll(async () => {
  orchestrator = await import("@/server/pipeline/orchestrator");
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  queue = await import("@/server/jobs/queue");

  repoId = service.createRepo({
    name: "acme/queue-hold",
    url: "https://github.com/acme/queue-hold",
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
  settings.updateSettings({ maxParallelTasks: 5, queueHeld: false });
});

describe("claimNextJobUnlessHeld (S6)", () => {
  it("claims nothing while held, even with eligible pending jobs", () => {
    const task = service.createTask({
      repoId,
      title: "Held",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);

    expect(queue.claimNextJobUnlessHeld(5, true)).toBeNull();
  });

  it("claims normally once not held", () => {
    const task = service.createTask({
      repoId,
      title: "Not held",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);

    const claimed = queue.claimNextJobUnlessHeld(5, false);
    expect(claimed).not.toBeNull();
    expect(claimed!.taskId).toBe(task.id);
  });

  it("a job already claimed before the flag was set is untouched by holding", () => {
    const task = service.createTask({
      repoId,
      title: "Mid-run",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    orchestrator.startTask(task.id);

    const claimed = queue.claimNextJobUnlessHeld(5, false);
    expect(claimed).not.toBeNull();

    // Held now — a second claim attempt on the same tick finds nothing new,
    // but nothing about the already-claimed job or its task changed: no
    // transition, no new status, exactly as §9.2 specifies.
    expect(queue.claimNextJobUnlessHeld(5, true)).toBeNull();
    expect(service.getTask(task.id)!.status).toBe("running");
  });
});
