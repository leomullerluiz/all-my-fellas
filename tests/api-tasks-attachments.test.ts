import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `GET`/`DELETE /api/tasks/:id/attachments/:attachmentId` — route tests.
 *
 * Follows the fixture pattern in `tests/api-tasks.test.ts`: a temp SQLite DB,
 * routes called directly as plain functions.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-attachments-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let taskRoute: typeof import("@/app/api/tasks/[id]/route");
let attachmentRoute: typeof import("@/app/api/tasks/[id]/attachments/[attachmentId]/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  taskRoute = await import("@/app/api/tasks/[id]/route");
  attachmentRoute = await import("@/app/api/tasks/[id]/attachments/[attachmentId]/route");

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

function seed(overrides: Partial<Parameters<typeof service.createTask>[0]> = {}) {
  return service.createTask({
    repoId,
    title: "A perfectly reasonable title",
    description: "A description long enough to pass the twenty character minimum.",
    priority: "medium",
    ...overrides,
  });
}

function attach(taskId: string, filename: string, content: string, mimeType: string) {
  // "binary" (latin1) keeps one JS char = one byte, so arbitrary byte content
  // (e.g. a fake PNG header) round-trips exactly through `size`/`buffer`.
  const buffer = Buffer.from(content, "binary");
  return service.insertAttachments(taskId, [
    { filename, mimeType, size: buffer.length, buffer },
  ])[0];
}

function taskParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function attachmentParams(id: string, attachmentId: string) {
  return { params: Promise.resolve({ id, attachmentId }) };
}

describe("GET /api/tasks/:id/attachments/:attachmentId", () => {
  it("returns the exact bytes with a matching Content-Type", async () => {
    const task = seed();
    const bytes = "\x89PNG-fake-bytes";
    const attachment = attach(task.id, "diagram.png", bytes, "image/png");

    const response = await attachmentRoute.GET(
      new Request("http://test"),
      attachmentParams(task.id, attachment.id),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString("binary")).toBe(bytes);
  });

  it("returns 404 for an attachment belonging to a different task", async () => {
    const task = seed({ title: "Owner" });
    const other = seed({ title: "Other" });
    const attachment = attach(task.id, "note.json", "{}", "application/json");

    const response = await attachmentRoute.GET(
      new Request("http://test"),
      attachmentParams(other.id, attachment.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown attachment id", async () => {
    const task = seed();
    const response = await attachmentRoute.GET(
      new Request("http://test"),
      attachmentParams(task.id, "att_missing"),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/tasks/:id lists attachments", () => {
  it("includes every attachment created in one submission", async () => {
    const task = seed();
    attach(task.id, "a.json", "{}", "application/json");
    attach(task.id, "b.xml", "<x/>", "application/xml");

    const response = await taskRoute.GET(new Request("http://test"), taskParams(task.id));
    const payload = (await response.json()) as {
      attachments: Array<{ filename: string; mimeType: string; sizeBytes: number; url: string }>;
    };
    expect(payload.attachments.map((a) => a.filename).sort()).toEqual(["a.json", "b.xml"]);
    expect(payload.attachments[0].url).toContain(`/api/tasks/${task.id}/attachments/`);
  });
});

describe("DELETE /api/tasks/:id/attachments/:attachmentId", () => {
  it("removes an attachment from a created task", async () => {
    const task = seed();
    const attachment = attach(task.id, "note.json", "{}", "application/json");

    const response = await attachmentRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      attachmentParams(task.id, attachment.id),
    );
    expect(response.status).toBe(200);
    expect(service.listAttachments(task.id)).toHaveLength(0);

    const getAfter = await attachmentRoute.GET(
      new Request("http://test"),
      attachmentParams(task.id, attachment.id),
    );
    expect(getAfter.status).toBe(404);
  });

  it("no longer lists a removed attachment on GET /api/tasks/:id", async () => {
    const task = seed();
    const kept = attach(task.id, "keep.json", "{}", "application/json");
    const removed = attach(task.id, "remove.json", "{}", "application/json");

    await attachmentRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      attachmentParams(task.id, removed.id),
    );

    const response = await taskRoute.GET(new Request("http://test"), taskParams(task.id));
    const payload = (await response.json()) as { attachments: Array<{ id: string }> };
    expect(payload.attachments.map((a) => a.id)).toEqual([kept.id]);
  });

  it("returns 409 for a task that is not CREATED", async () => {
    const task = seed();
    const attachment = attach(task.id, "note.json", "{}", "application/json");
    service.setTaskStage(task.id, "DEVELOPMENT");

    const response = await attachmentRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      attachmentParams(task.id, attachment.id),
    );
    expect(response.status).toBe(409);
    expect(service.listAttachments(task.id)).toHaveLength(1);
  });

  it("returns 404 for a non-existent attachment id", async () => {
    const task = seed();
    const response = await attachmentRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      attachmentParams(task.id, "att_missing"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for an attachment belonging to a different task", async () => {
    const task = seed({ title: "Owner" });
    const other = seed({ title: "Other" });
    const attachment = attach(other.id, "note.json", "{}", "application/json");

    const response = await attachmentRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      attachmentParams(task.id, attachment.id),
    );
    expect(response.status).toBe(404);
    expect(service.listAttachments(other.id)).toHaveLength(1);
  });

  it("returns 404 for an unknown task", async () => {
    const response = await attachmentRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      attachmentParams("task_missing", "att_missing"),
    );
    expect(response.status).toBe(404);
  });
});
