import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Route-handler tests.
 *
 * Next route handlers are plain `(Request, ctx) => Response` functions, so they
 * can be called directly — no HTTP server needed. This covers the status codes
 * the UI branches on, which unit tests of the orchestrator alone would miss.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let tasksRoute: typeof import("@/app/api/tasks/route");
let taskRoute: typeof import("@/app/api/tasks/[id]/route");
let startRoute: typeof import("@/app/api/tasks/[id]/start/route");
let retryRoute: typeof import("@/app/api/tasks/[id]/retry/route");
let repoId: string;

const ALL_STAGES = [
  "STAKEHOLDER_REFINEMENT",
  "PO_REFINEMENT",
  "ARCHITECTURE",
  "PLAN_GATE",
  "DEVELOPMENT",
  "QA",
  "PO_HOMOLOGATION",
  "STAKEHOLDER_GATE",
  "DELIVERY",
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  orchestrator = await import("@/server/pipeline/orchestrator");
  tasksRoute = await import("@/app/api/tasks/route");
  taskRoute = await import("@/app/api/tasks/[id]/route");
  startRoute = await import("@/app/api/tasks/[id]/start/route");
  retryRoute = await import("@/app/api/tasks/[id]/retry/route");

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

const VALID_BODY = {
  repoId: "",
  title: "A perfectly reasonable title",
  description: "A description long enough to pass the twenty character minimum.",
  priority: "medium" as const,
};

function post(body: unknown) {
  return tasksRoute.POST(
    new Request("http://test/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function seed(overrides: Partial<typeof VALID_BODY> = {}) {
  return service.createTask({ ...VALID_BODY, repoId, ...overrides });
}

describe("POST /api/tasks", () => {
  it("creates without starting by default", async () => {
    const response = await post({ ...VALID_BODY, repoId });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { task: { id: string }; started: boolean };
    expect(payload.started).toBe(false);
    expect(service.getTask(payload.task.id)!.currentStage).toBe("CREATED");
  });

  it("starts when asked", async () => {
    const response = await post({ ...VALID_BODY, repoId, start: true });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { task: { id: string }; started: boolean };
    expect(payload.started).toBe(true);
    expect(service.getTask(payload.task.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("returns 409 but still creates the task when no slot is free", async () => {
    const blocking = seed({ title: "Already running" });
    orchestrator.startTask(blocking.id);

    const response = await post({ ...VALID_BODY, repoId, start: true });
    expect(response.status).toBe(409);

    const payload = (await response.json()) as {
      task: { id: string };
      started: boolean;
      error: string;
    };
    expect(payload.started).toBe(false);
    expect(payload.error).toContain("Limit of 1 task");
    // The work is not lost: the task exists and can be started later.
    expect(service.getTask(payload.task.id)!.currentStage).toBe("CREATED");
  });

  it("rejects an invalid payload with field errors", async () => {
    const response = await post({ repoId, title: "x", description: "short" });
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { details: Record<string, string> };
    expect(payload.details).toHaveProperty("title");
    expect(payload.details).toHaveProperty("description");
  });

  it("rejects an unknown repository", async () => {
    const response = await post({ ...VALID_BODY, repoId: "repo_missing" });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/tasks/:id/start", () => {
  it("starts a created task", async () => {
    const task = seed();
    const response = await startRoute.POST(new Request("http://test"), params(task.id));

    expect(response.status).toBe(200);
    expect(service.getTask(task.id)!.currentStage).toBe("STAKEHOLDER_REFINEMENT");
  });

  it("returns 409 on a double start rather than a 500", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const task = seed();
    await startRoute.POST(new Request("http://test"), params(task.id));

    const second = await startRoute.POST(new Request("http://test"), params(task.id));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain("already been started");
  });

  it("returns 409 when no slot is free", async () => {
    const blocking = seed({ title: "Holder" });
    orchestrator.startTask(blocking.id);
    const task = seed();

    const response = await startRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("Holder");
  });

  it("returns 404 for an unknown task", async () => {
    const response = await startRoute.POST(new Request("http://test"), params("task_missing"));
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/tasks/:id", () => {
  function patch(id: string, body: unknown) {
    return taskRoute.PATCH(
      new Request("http://test", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(id),
    );
  }

  it("updates a created task", async () => {
    const task = seed();
    const response = await patch(task.id, {
      ...VALID_BODY,
      repoId,
      title: "Renamed",
      priority: "urgent",
    });

    expect(response.status).toBe(200);
    const updated = service.getTask(task.id)!;
    expect(updated.title).toBe("Renamed");
    expect(updated.priority).toBe("urgent");
  });

  it("returns 409 for every stage past CREATED", async () => {
    for (const stage of ALL_STAGES) {
      const task = seed({ title: `Task at ${stage}` });
      service.setTaskStage(task.id, stage);

      const response = await patch(task.id, { ...VALID_BODY, repoId, title: "Nope" });
      expect(response.status, `stage ${stage} must refuse edits`).toBe(409);
      expect(service.getTask(task.id)!.title).toBe(`Task at ${stage}`);
    }
  });

  it("validates the payload", async () => {
    const task = seed();
    const response = await patch(task.id, { repoId, title: "x", description: "short" });
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown task", async () => {
    const response = await patch("task_missing", { ...VALID_BODY, repoId });
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/tasks/:id", () => {
  function del(id: string) {
    return taskRoute.DELETE(new Request("http://test", { method: "DELETE" }), params(id));
  }

  it("deletes a created task", async () => {
    const task = seed();
    const response = await del(task.id);

    expect(response.status).toBe(200);
    expect(service.getTask(task.id)).toBeNull();
  });

  it("returns 409 for every stage past CREATED", async () => {
    for (const stage of ALL_STAGES) {
      const task = seed({ title: `Task at ${stage}` });
      service.setTaskStage(task.id, stage);

      const response = await del(task.id);
      expect(response.status, `stage ${stage} must refuse deletion`).toBe(409);
      expect(service.getTask(task.id)).not.toBeNull();
    }
  });

  it("cascades child rows", async () => {
    settings.updateSettings({ maxParallelTasks: 5 });
    const events = await import("@/server/events/store");
    const task = seed();
    orchestrator.startTask(task.id);
    expect(service.listStageRuns(task.id).length).toBeGreaterThan(0);

    service.setTaskStage(task.id, "CREATED");
    await del(task.id);

    expect(service.listStageRuns(task.id)).toHaveLength(0);
    expect(events.readEvents(task.id)).toHaveLength(0);
  });

  it("returns 404 for an unknown task", async () => {
    expect((await del("task_missing")).status).toBe(404);
  });
});

describe("POST /api/tasks/:id/retry", () => {
  function fail(title: string) {
    const task = seed({ title });
    orchestrator.startTask(task.id);
    const run = service.listStageRuns(task.id).at(-1)!;
    service.markStageRunStatus(run.id, "failed", { error: "boom" });
    orchestrator.advanceTask(task.id, {
      kind: "stage_failed",
      stage: "STAKEHOLDER_REFINEMENT",
      error: "boom",
    });
    return task;
  }

  it("retries when a slot is free", async () => {
    const task = fail("Failed");
    const response = await retryRoute.POST(new Request("http://test"), params(task.id));

    expect(response.status).toBe(200);
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  it("returns 409 when no slot is free", async () => {
    const task = fail("Failed");
    const other = seed({ title: "Occupier" });
    orchestrator.startTask(other.id);

    const response = await retryRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(409);
    expect(service.getTask(task.id)!.status).toBe("failed");
  });

  it("returns 409 for a task that did not fail", async () => {
    const task = seed();
    const response = await retryRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(409);
  });
});

describe("GET /api/tasks", () => {
  it("reports capacity alongside the list", async () => {
    const task = seed();
    orchestrator.startTask(task.id);

    const response = await tasksRoute.GET(new Request("http://test/api/tasks"));
    const payload = (await response.json()) as {
      tasks: unknown[];
      capacity: { limit: number; active: number; slotAvailable: boolean };
    };

    expect(payload.tasks).toHaveLength(1);
    expect(payload.capacity).toMatchObject({ limit: 1, active: 1, slotAvailable: false });
  });
});
