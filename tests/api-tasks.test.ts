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

/** Builds the multipart body the client sends once a file is picked. */
function multipartForm(fields: Record<string, unknown>, files: File[] = []): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, String(value));
  }
  for (const file of files) form.append("attachments", file);
  return form;
}

function postMultipart(fields: Record<string, unknown>, files: File[] = []) {
  return tasksRoute.POST(
    new Request("http://test/api/tasks", {
      method: "POST",
      body: multipartForm(fields, files),
    }),
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function seed(overrides: Partial<typeof VALID_BODY> = {}) {
  return service.createTask({ ...VALID_BODY, repoId, ...overrides });
}

/** Starts a task and parks it on `PLAN_GATE`, awaiting a human decision. */
function gated(title: string) {
  const task = seed({ title });
  orchestrator.startTask(task.id);
  service.setTaskStage(task.id, "PLAN_GATE");
  return task;
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

  it("returns 409 but still creates the task when start: true and a dependency is incomplete", async () => {
    const prereq = seed({ title: "Prereq" });

    const response = await post({ ...VALID_BODY, repoId, start: true, dependsOn: [prereq.id] });
    expect(response.status).toBe(409);

    const payload = (await response.json()) as {
      task: { id: string };
      started: boolean;
      error: string;
    };
    expect(payload.started).toBe(false);
    expect(payload.error).toContain("Prereq");
    // The work is not lost: the task exists at CREATED and can be started later.
    expect(service.getTask(payload.task.id)!.currentStage).toBe("CREATED");
  });

  it("starts with 201 even while another task is awaiting_gate", async () => {
    gated("Awaiting approval");

    const response = await post({ ...VALID_BODY, repoId, start: true });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { task: { id: string }; started: boolean };
    expect(payload.started).toBe(true);
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

  it("accepts a description of exactly 50,000 characters", async () => {
    const response = await post({ ...VALID_BODY, repoId, description: "a".repeat(50_000) });
    expect(response.status).toBe(201);
  });

  it("rejects a description of 50,001 characters", async () => {
    const response = await post({ ...VALID_BODY, repoId, description: "a".repeat(50_001) });
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { details: Record<string, string> };
    expect(payload.details.description).not.toContain("20000");
    expect(payload.details.description).not.toContain("20,000");
  });

  it("creates a task with no dependencies when dependsOn is omitted", async () => {
    const response = await post({ ...VALID_BODY, repoId });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { task: { id: string } };
    const detail = await taskRoute.GET(new Request("http://test"), params(payload.task.id));
    const detailPayload = (await detail.json()) as { dependsOn: unknown[] };
    expect(detailPayload.dependsOn).toEqual([]);
  });

  it("creates a task with a valid dependency", async () => {
    const prereq = seed({ title: "Prereq" });

    const response = await post({ ...VALID_BODY, repoId, dependsOn: [prereq.id] });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { task: { id: string } };
    const detail = await taskRoute.GET(new Request("http://test"), params(payload.task.id));
    const detailPayload = (await detail.json()) as { dependsOn: Array<{ id: string }> };
    expect(detailPayload.dependsOn.map((d) => d.id)).toEqual([prereq.id]);
  });

  it("rejects an unknown dependency id", async () => {
    const response = await post({ ...VALID_BODY, repoId, dependsOn: ["task_missing"] });
    expect(response.status).toBe(400);
    expect(service.listTasks()).toHaveLength(0);
  });

  it("rejects a dependency on an already-completed task", async () => {
    const done = seed({ title: "Already shipped" });
    service.setTaskStage(done.id, "COMPLETED");

    const response = await post({ ...VALID_BODY, repoId, dependsOn: [done.id] });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Already shipped");
    expect(service.listTasks()).toHaveLength(1); // only `done`, nothing new created
  });

  it("accepts multiple attachments in one multipart submission", async () => {
    const image = new File([new Uint8Array([1, 2, 3])], "diagram.png", { type: "image/png" });
    const config = new File(['{"a":1}'], "config.json", { type: "application/json" });

    const response = await postMultipart({ ...VALID_BODY, repoId }, [image, config]);
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { task: { id: string } };
    const detail = await taskRoute.GET(new Request("http://test"), params(payload.task.id));
    const detailPayload = (await detail.json()) as {
      attachments: Array<{ filename: string }>;
    };
    expect(detailPayload.attachments.map((a) => a.filename).sort()).toEqual([
      "config.json",
      "diagram.png",
    ]);
  });

  it("rejects an unsupported file type, naming the file and its type", async () => {
    const exe = new File(["MZ"], "installer.exe", { type: "application/x-msdownload" });

    const response = await postMultipart({ ...VALID_BODY, repoId }, [exe]);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("installer.exe");
    expect(payload.error).toContain("application/x-msdownload");

    // No task and no attachment should have been created.
    expect(service.listTasks()).toHaveLength(0);
  });

  it("rejects an empty file without creating a record", async () => {
    const empty = new File([], "empty.json", { type: "application/json" });

    const response = await postMultipart({ ...VALID_BODY, repoId }, [empty]);
    expect(response.status).toBe(400);
    expect(service.listTasks()).toHaveLength(0);
  });

  // A file with no filename cannot survive a real multipart round-trip (an
  // empty `filename=` degrades the part to a plain text field before it
  // reaches the server) — see `tests/attachments-validation.test.ts` for the
  // rejection itself, exercised directly against `validateAttachmentFiles`.

  it("creates without attachments over multipart when none are picked", async () => {
    const response = await postMultipart({ ...VALID_BODY, repoId });
    expect(response.status).toBe(201);
  });

  describe("branchName", () => {
    it("stores a valid custom branch name and falls back to auto-generation when omitted", async () => {
      const withCustom = await post({ ...VALID_BODY, repoId, branchName: "feature/my-custom-name" });
      expect(withCustom.status).toBe(201);
      const withCustomPayload = (await withCustom.json()) as { task: { id: string } };
      expect(service.getTask(withCustomPayload.task.id)!.customBranchName).toBe(
        "feature/my-custom-name",
      );

      const withoutCustom = await post({ ...VALID_BODY, repoId });
      expect(withoutCustom.status).toBe(201);
      const withoutCustomPayload = (await withoutCustom.json()) as { task: { id: string } };
      expect(service.getTask(withoutCustomPayload.task.id)!.customBranchName).toBeNull();
    });

    it("accepts a bugfix-style valid name unchanged", async () => {
      const response = await post({ ...VALID_BODY, repoId, branchName: "bugfix-123" });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { task: { id: string } };
      expect(service.getTask(payload.task.id)!.customBranchName).toBe("bugfix-123");
    });

    it("creates normally even when the chosen name collides with nothing yet (no existence check)", async () => {
      const response = await post({ ...VALID_BODY, repoId, branchName: "already-taken" });
      expect(response.status).toBe(201);
    });

    const INVALID_CASES: Array<{ name: string; branchName: string }> = [
      { name: "contains a space", branchName: "feature with space" },
      { name: "contains a forbidden character (~)", branchName: "feature~1" },
      { name: "contains a forbidden character (^)", branchName: "feature^1" },
      { name: "contains a forbidden character (:)", branchName: "feature:1" },
      { name: "contains a forbidden character (?)", branchName: "feature?1" },
      { name: "contains a forbidden character (*)", branchName: "feature*1" },
      { name: "contains a forbidden character ([)", branchName: "feature[1" },
      { name: "contains a forbidden character (`)", branchName: "feature`1" },
      { name: "contains ..", branchName: "feature..name" },
      { name: "starts with -", branchName: "-feature" },
      { name: "starts with .", branchName: ".feature" },
      { name: "starts with /", branchName: "/feature" },
      { name: "ends with /", branchName: "feature/" },
      { name: "ends with .", branchName: "feature." },
      { name: "ends with .lock", branchName: "feature.lock" },
      { name: "is longer than 200 characters", branchName: "a".repeat(201) },
      { name: "is bare @", branchName: "@" },
    ];

    for (const { name, branchName } of INVALID_CASES) {
      it(`rejects a branch name that ${name}`, async () => {
        const response = await post({ ...VALID_BODY, repoId, branchName });
        expect(response.status).toBe(400);
        const payload = (await response.json()) as { error: string; details: Record<string, string> };
        expect(payload.details).toHaveProperty("branchName");
      });
    }

    it("treats an empty/whitespace-only value as not provided", async () => {
      const response = await post({ ...VALID_BODY, repoId, branchName: "   " });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { task: { id: string } };
      expect(service.getTask(payload.task.id)!.customBranchName).toBeNull();
    });
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

  it("starts a different task while one is awaiting_gate", async () => {
    gated("Awaiting approval");
    const task = seed();

    const response = await startRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(200);
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  it("returns 409 naming an incomplete prerequisite", async () => {
    const prereq = seed({ title: "Design the schema" });
    const task = seed({ title: "Depends on schema" });
    service.replaceDependencies(task.id, [prereq.id]);

    const response = await startRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("Design the schema");
    expect(service.getTask(task.id)!.currentStage).toBe("CREATED");
  });

  it("starts once the prerequisite is COMPLETED", async () => {
    const prereq = seed({ title: "Design the schema" });
    service.setTaskStage(prereq.id, "COMPLETED");
    const task = seed({ title: "Depends on schema" });
    service.replaceDependencies(task.id, [prereq.id]);

    const response = await startRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(200);
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

  it("accepts a description of exactly 50,000 characters", async () => {
    const task = seed();
    const response = await patch(task.id, {
      ...VALID_BODY,
      repoId,
      description: "a".repeat(50_000),
    });
    expect(response.status).toBe(200);
  });

  it("rejects a description of 50,001 characters", async () => {
    const task = seed();
    const response = await patch(task.id, {
      ...VALID_BODY,
      repoId,
      description: "a".repeat(50_001),
    });
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { details: Record<string, string> };
    expect(payload.details.description).not.toContain("20000");
    expect(payload.details.description).not.toContain("20,000");
  });

  it("replaces the stored dependency set and round-trips it through GET", async () => {
    const prereq = seed({ title: "Prereq" });
    const task = seed();

    const response = await patch(task.id, { ...VALID_BODY, repoId, dependsOn: [prereq.id] });
    expect(response.status).toBe(200);

    const detail = await taskRoute.GET(new Request("http://test"), params(task.id));
    const payload = (await detail.json()) as { dependsOn: Array<{ id: string }> };
    expect(payload.dependsOn.map((d) => d.id)).toEqual([prereq.id]);
  });

  it("rejects an unknown dependency id", async () => {
    const task = seed();
    const response = await patch(task.id, { ...VALID_BODY, repoId, dependsOn: ["task_missing"] });
    expect(response.status).toBe(400);
  });

  it("rejects a dependency on an already-completed task", async () => {
    const done = seed({ title: "Already shipped" });
    service.setTaskStage(done.id, "COMPLETED");
    const task = seed({ title: "Editing this one" });

    const response = await patch(task.id, { ...VALID_BODY, repoId, dependsOn: [done.id] });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Already shipped");
  });

  it("rejects a self-reference", async () => {
    const task = seed();
    const response = await patch(task.id, { ...VALID_BODY, repoId, dependsOn: [task.id] });
    expect(response.status).toBe(400);
  });

  it("rejects a direct two-hop cycle, naming the tasks in the cycle", async () => {
    const a = seed({ title: "Task Alpha" });
    const b = seed({ title: "Task Beta" });
    // b depends on a
    await patch(b.id, { ...VALID_BODY, title: "Task Beta", repoId, dependsOn: [a.id] });

    // now try to make a depend on b, closing the cycle
    const response = await patch(a.id, {
      ...VALID_BODY,
      title: "Task Alpha",
      repoId,
      dependsOn: [b.id],
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Task Alpha");
    expect(payload.error).toContain("Task Beta");
  });

  it("rejects a transitive three-hop cycle (A -> B -> C -> A)", async () => {
    const a = seed({ title: "Task Alpha" });
    const b = seed({ title: "Task Beta" });
    const c = seed({ title: "Task Gamma" });
    await patch(b.id, { ...VALID_BODY, title: "Task Beta", repoId, dependsOn: [a.id] });
    await patch(c.id, { ...VALID_BODY, title: "Task Gamma", repoId, dependsOn: [b.id] });

    const response = await patch(a.id, {
      ...VALID_BODY,
      title: "Task Alpha",
      repoId,
      dependsOn: [c.id],
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown task", async () => {
    const response = await patch("task_missing", { ...VALID_BODY, repoId });
    expect(response.status).toBe(404);
  });

  function patchMultipart(id: string, fields: Record<string, unknown>, files: File[] = []) {
    return taskRoute.PATCH(
      new Request("http://test", { method: "PATCH", body: multipartForm(fields, files) }),
      params(id),
    );
  }

  it("adds an attachment to a created task over multipart", async () => {
    const task = seed();
    const file = new File(["<x/>"], "note.xml", { type: "application/xml" });

    const response = await patchMultipart(task.id, { ...VALID_BODY, repoId }, [file]);
    expect(response.status).toBe(200);

    const detail = await taskRoute.GET(new Request("http://test"), params(task.id));
    const payload = (await detail.json()) as { attachments: Array<{ filename: string }> };
    expect(payload.attachments.map((a) => a.filename)).toEqual(["note.xml"]);
  });

  it("returns 409 when adding an attachment to a task past CREATED", async () => {
    for (const stage of ALL_STAGES) {
      const task = seed({ title: `Task at ${stage}` });
      service.setTaskStage(task.id, stage);
      const file = new File(["x"], "a.json", { type: "application/json" });

      const response = await patchMultipart(task.id, { ...VALID_BODY, repoId }, [file]);
      expect(response.status, `stage ${stage} must refuse an attachment upload`).toBe(409);
    }
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
    // A plain stage_error retry is not a rework-budget grant.
    expect(service.getTask(task.id)!.reworkBudgetGrant).toBe(0);
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

  it("retries while another task is awaiting_gate", async () => {
    gated("Awaiting approval");
    const task = fail("Failed");

    const response = await retryRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(200);
    expect(service.getTask(task.id)!.status).toBe("running");
  });

  /**
   * Fails a task on rework exhaustion — every run is "done", none "failed" —
   * exactly the case `.filter(status === "failed").at(-1)` could never find
   * (`spec-retry-recovery.md` §3.2). `developmentAttempts` runs already exist
   * before the rejecting CODE_REVIEW run, so the shared budget (2 by default)
   * is already spent when it rejects.
   */
  function reworkExhausted(title: string, developmentAttempts: number) {
    const task = seed({ title });
    orchestrator.startTask(task.id);
    for (let attempt = 1; attempt <= developmentAttempts; attempt += 1) {
      service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt });
    }
    // `rework_exhausted` always needs branch history (§9): a real workspace
    // has to be on disk for the retry to be offered at all.
    fs.mkdirSync(path.join(process.env.WORKSPACES_DIR!, task.id, ".git"), { recursive: true });
    service.setTaskStage(task.id, "CODE_REVIEW");
    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "CODE_REVIEW",
      reviewVerdict: "changes_requested",
    });
    return task;
  }

  it("recovers a rework-exhausted task, where the old scan found nothing", async () => {
    const task = reworkExhausted("Budget exhausted", 3);
    const before = service.getTask(task.id)!;
    expect(before.status).toBe("failed");
    expect(before.failedStage).toBe("DEVELOPMENT");
    expect(before.failureKind).toBe("rework_exhausted");

    const response = await retryRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(200);

    const after = service.getTask(task.id)!;
    expect(after.status).toBe("running");
    expect(after.currentStage).toBe("DEVELOPMENT");
    expect(after.reworkBudgetGrant).toBe(1);
    const developmentRuns = service
      .listStageRuns(task.id)
      .filter((run) => run.stage === "DEVELOPMENT");
    expect(developmentRuns).toHaveLength(4);
    expect(developmentRuns.at(-1)!.attempt).toBe(4);
  });

  it("grants exactly one extra cycle per retry — two retries, two extra runs, not four", async () => {
    const task = reworkExhausted("Two retries", 3);
    await retryRoute.POST(new Request("http://test"), params(task.id));
    expect(service.getTask(task.id)!.reworkBudgetGrant).toBe(1);

    // Exhaust again: developmentAttempts is now 4, effective ceiling 2 + 1 = 3.
    service.setTaskStage(task.id, "CODE_REVIEW");
    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "CODE_REVIEW",
      reviewVerdict: "changes_requested",
    });
    expect(service.getTask(task.id)!.status).toBe("failed");

    await retryRoute.POST(new Request("http://test"), params(task.id));

    const after = service.getTask(task.id)!;
    expect(after.reworkBudgetGrant).toBe(2);
    const developmentRuns = service
      .listStageRuns(task.id)
      .filter((run) => run.stage === "DEVELOPMENT");
    expect(developmentRuns).toHaveLength(5);
    expect(developmentRuns.map((run) => run.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not grant a rework cycle when a rework-exhausted retry is refused for capacity", async () => {
    const task = reworkExhausted("Blocked, would have granted", 3);
    const other = seed({ title: "Occupier" });
    orchestrator.startTask(other.id);

    const response = await retryRoute.POST(new Request("http://test"), params(task.id));
    expect(response.status).toBe(409);
    // The capacity check and the grant share one transaction; a refused
    // retry must leave the column untouched (S2).
    expect(service.getTask(task.id)!.reworkBudgetGrant).toBe(0);
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

  it("never lists an awaiting_gate task in capacity.blocking", async () => {
    const task = gated("Awaiting approval");

    const response = await tasksRoute.GET(new Request("http://test/api/tasks"));
    const payload = (await response.json()) as {
      capacity: { slotAvailable: boolean; blocking: Array<{ id: string }> };
    };

    expect(payload.capacity.slotAvailable).toBe(true);
    expect(payload.capacity.blocking.map((t) => t.id)).not.toContain(task.id);
    expect(payload.capacity.blocking).toEqual([]);
  });
});
