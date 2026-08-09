import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S6 — the webhook dispatcher hung off `appendEvent` (§8). Covers: the
 * post-commit-only timing contract, the exact JSON body and HMAC signature,
 * the per-event-type filter, and that a failing endpoint is retried and
 * never raises into the pipeline.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notifications-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");
process.env.PIPELINE_WEBHOOK_SECRET = "s3cr3t";

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let eventsStore: typeof import("@/server/events/store");
let dispatchModule: typeof import("@/server/notifications/dispatch");
let repoId: string;
let taskId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  eventsStore = await import("@/server/events/store");
  dispatchModule = await import("@/server/notifications/dispatch");

  repoId = service.createRepo({
    name: "acme/notifications",
    url: "https://github.com/acme/notifications",
    defaultBranch: "main",
  }).id;
  taskId = service.createTask({
    repoId,
    title: "Notify me",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  settings.updateSettings({
    notifications: {
      browser: true,
      webhookUrl: "https://hooks.example.com/pipeline",
      webhookSecretRef: null,
      events: { gate_opened: true, task_finished: true, pr_opened: true, quota_warning: true, log: false },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchNotification (S6)", () => {
  it("posts the documented JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchModule.dispatchNotification(taskId, { type: "gate_opened", gate: "PLAN_GATE" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/pipeline");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      event: "gate_opened",
      taskId,
      taskTitle: "Notify me",
      repo: "acme/notifications",
      stage: "PLAN_GATE",
    });
    expect(body.url).toContain(taskId);
    expect(typeof body.at).toBe("number");
  });

  it("signs the exact raw body with X-Signature when a secret is configured", async () => {
    settings.updateSettings({
      notifications: {
        browser: true,
        webhookUrl: "https://hooks.example.com/pipeline",
        webhookSecretRef: "PIPELINE_WEBHOOK_SECRET",
        events: { gate_opened: true },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchModule.dispatchNotification(taskId, { type: "gate_opened", gate: "PLAN_GATE" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const raw = init.body as string;
    const headers = init.headers as Record<string, string>;
    const expected = `sha256=${createHmac("sha256", "s3cr3t").update(raw).digest("hex")}`;
    expect(headers["X-Signature"]).toBe(expected);
  });

  it("does not dispatch a disabled event type", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await dispatchModule.dispatchNotification(taskId, { type: "log", level: "info", message: "hi" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not dispatch at all when no webhook URL is configured", async () => {
    settings.updateSettings({
      notifications: {
        browser: true,
        webhookUrl: null,
        webhookSecretRef: null,
        events: { gate_opened: true },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await dispatchModule.dispatchNotification(taskId, { type: "gate_opened", gate: "PLAN_GATE" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failing endpoint up to three times and never throws", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchModule.dispatchNotification(taskId, { type: "gate_opened", gate: "PLAN_GATE" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("swallows a permanently failing endpoint without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchModule.dispatchNotification(taskId, { type: "gate_opened", gate: "PLAN_GATE" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);
});

describe("appendEvent — dispatch only fires after the transaction commits (S6)", () => {
  it("does not dispatch when the transaction rolls back", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // A task id that does not exist violates the events.task_id foreign key
    // (`PRAGMA foreign_keys = ON`), so the insert — and the whole transaction
    // — rolls back before `appendEvent` ever reaches the dispatch call.
    expect(() =>
      eventsStore.appendEvent("task_does_not_exist", null, { type: "log", level: "info", message: "x" }),
    ).toThrow();

    // Give the fire-and-forget dispatch a turn of the event loop to run, if
    // it was (incorrectly) scheduled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches once the transaction has committed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);

    eventsStore.appendEvent(taskId, null, { type: "gate_opened", gate: "PLAN_GATE" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
