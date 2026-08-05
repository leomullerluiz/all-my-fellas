import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `POST /api/tasks/batch-start` — route and orchestrator tests.
 *
 * Follows the fixture pattern in `tests/api-tasks.test.ts`: a temp SQLite DB,
 * `maxParallelTasks` set low so capacity boundaries are easy to hit.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-batch-start-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let batchStartRoute: typeof import("@/app/api/tasks/batch-start/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  orchestrator = await import("@/server/pipeline/orchestrator");
  batchStartRoute = await import("@/app/api/tasks/batch-start/route");

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
  settings.updateSettings({ maxParallelTasks: 1 });
});

const VALID_BODY: {
  repoId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
} = {
  repoId: "",
  title: "A perfectly reasonable title",
  description: "A description long enough to pass the twenty character minimum.",
  priority: "medium",
};

function seed(overrides: Partial<typeof VALID_BODY> = {}) {
  return service.createTask({ ...VALID_BODY, repoId, ...overrides });
}

function post(taskIds: string[]) {
  return batchStartRoute.POST(
    new Request("http://test/api/tasks/batch-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds }),
    }),
  );
}

type Result = {
  taskId: string;
  title: string;
  started: boolean;
  queued: boolean;
  reason: string | null;
};

describe("POST /api/tasks/batch-start", () => {
  it("rejects an empty selection", async () => {
    const response = await post([]);
    expect(response.status).toBe(400);
  });

  it("starts every task when capacity allows", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const a = seed({ title: "A" });
    const b = seed({ title: "B" });

    const response = await post([a.id, b.id]);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { results: Result[] };
    expect(payload.results.every((r) => r.started)).toBe(true);
    expect(service.getTask(a.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
    expect(service.getTask(b.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("orders by priority descending before starting", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const low = seed({ title: "Low", priority: "low" });
    const urgent = seed({ title: "Urgent", priority: "urgent" });
    const medium = seed({ title: "Medium", priority: "medium" });

    const response = await post([low.id, urgent.id, medium.id]);
    const payload = (await response.json()) as { results: Result[] };

    const order = payload.results.filter((r) => r.started).map((r) => r.title);
    expect(order).toEqual(["Urgent", "Medium", "Low"]);
  });

  it("orders by difficulty ascending within the same priority", async () => {
    // `difficulty` is only ever set by the Architect stage post-start, so a
    // `CREATED` task never has one through the real UI flow; setting it here
    // via the service layer exercises the tiebreak in isolation, as noted in
    // `techplan.md`'s "Difficulty tiebreak is inert for this feature today".
    settings.updateSettings({ maxParallelTasks: 5 });
    const large = seed({ title: "Large" });
    service.setTaskEstimate(large.id, "L", null);
    const small = seed({ title: "Small" });
    service.setTaskEstimate(small.id, "S", null);
    const unset = seed({ title: "Unset" });

    const response = await post([large.id, unset.id, small.id]);
    const payload = (await response.json()) as { results: Result[] };

    const order = payload.results.filter((r) => r.started).map((r) => r.title);
    expect(order).toEqual(["Small", "Unset", "Large"]);
  });

  it("fills only the remaining capacity, parking the rest on the queue in sorted order", async () => {
    settings.updateSettings({ maxParallelTasks: 2 });
    const already = seed({ title: "Already running" });
    orchestrator.startTask(already.id);

    const urgent = seed({ title: "Urgent", priority: "urgent" });
    const high = seed({ title: "High", priority: "high" });
    const medium = seed({ title: "Medium", priority: "medium" });

    const response = await post([medium.id, high.id, urgent.id]);
    const payload = (await response.json()) as { results: Result[] };

    const started = payload.results.filter((r) => r.started).map((r) => r.title);
    expect(started).toEqual(["Urgent"]);

    const skipped = payload.results.find((r) => r.title === "High");
    expect(skipped?.started).toBe(false);
    expect(skipped?.queued).toBe(true);
    expect(skipped?.reason).toContain("Limit of 2 tasks in progress reached");

    expect(service.getTask(urgent.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
    expect(service.getTask(high.id)!.currentStage).toBe("CREATED");
    expect(service.getTask(high.id)!.status).toBe("on_queue");
    expect(service.getTask(medium.id)!.currentStage).toBe("CREATED");
    expect(service.getTask(medium.id)!.status).toBe("on_queue");

    const missingQueued = payload.results.find((r) => r.title === "Urgent");
    expect(missingQueued?.queued).toBe(false);
  });

  it("auto-promotes the next queued task once the active one finishes", async () => {
    settings.updateSettings({ maxParallelTasks: 1 });
    const urgent = seed({ title: "Urgent", priority: "urgent" });
    const high = seed({ title: "High", priority: "high" });
    const medium = seed({ title: "Medium", priority: "medium" });

    const response = await post([medium.id, high.id, urgent.id]);
    const payload = (await response.json()) as { results: Result[] };

    expect(payload.results.filter((r) => r.started)).toHaveLength(1);
    expect(payload.results.filter((r) => r.queued)).toHaveLength(2);
    expect(service.getTask(urgent.id)!.status).toBe("running");
    expect(service.getTask(high.id)!.status).toBe("on_queue");
    expect(service.getTask(medium.id)!.status).toBe("on_queue");

    // The active task finishes (a real transition, not a direct status
    // write, so `promoteQueue` actually fires); the next queued task (High,
    // by priority) starts on its own — no additional client request.
    orchestrator.cancelTask(urgent.id);

    expect(service.getTask(high.id)!.status).toBe("running");
    expect(service.getTask(medium.id)!.status).toBe("on_queue");

    // Cancelling the now-running High task frees the slot again, promoting
    // Medium — the last task from the original batch.
    orchestrator.cancelTask(high.id);
    expect(service.getTask(medium.id)!.status).toBe("running");
  });

  it("continues past a mid-batch InvalidTransitionError", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const alreadyStarted = seed({ title: "Already started", priority: "urgent" });
    orchestrator.startTask(alreadyStarted.id);
    const fresh = seed({ title: "Fresh", priority: "high" });

    const response = await post([alreadyStarted.id, fresh.id]);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { results: Result[] };
    const first = payload.results.find((r) => r.taskId === alreadyStarted.id);
    expect(first?.started).toBe(false);
    expect(first?.reason).toContain("already been started");

    const second = payload.results.find((r) => r.taskId === fresh.id);
    expect(second?.started).toBe(true);
    expect(service.getTask(fresh.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("reports an unknown id as a skipped result instead of throwing", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const task = seed({ title: "Real task" });

    const response = await post(["task_missing", task.id]);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { results: Result[] };
    const missing = payload.results.find((r) => r.taskId === "task_missing");
    expect(missing?.started).toBe(false);
    expect(missing?.reason).toBeTruthy();

    const real = payload.results.find((r) => r.taskId === task.id);
    expect(real?.started).toBe(true);
  });

  it("skips a task with an incomplete prerequisite, naming it, and continues the batch", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const prereq = seed({ title: "Prereq" });
    const blocked = seed({ title: "Blocked" });
    service.replaceDependencies(blocked.id, [prereq.id]);
    const clear = seed({ title: "Clear" });

    const response = await post([blocked.id, clear.id]);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { results: Result[] };
    const blockedResult = payload.results.find((r) => r.taskId === blocked.id)!;
    expect(blockedResult.started).toBe(false);
    expect(blockedResult.reason).toContain("Prereq");

    const clearResult = payload.results.find((r) => r.taskId === clear.id)!;
    expect(clearResult.started).toBe(true);
    expect(service.getTask(clear.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("starting a single selected task matches the single-task Start action", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const task = seed();

    const response = await post([task.id]);
    expect(response.status).toBe(200);
    expect(service.getTask(task.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
    expect(service.getTask(task.id)!.status).toBe("running");
  });
});
