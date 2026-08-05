import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Usage-quota math for the dashboard's bottom bar.
 *
 * - `periodStart`/`nextReset` — S2's daily-midnight/hourly-top-of-hour
 *   boundaries, computed in local server time (see `quota.ts`'s DST note).
 * - `resolveQuotaStatus` — S2's not-configured/normal/exceeded states and
 *   S3's 80%/100% warning thresholds.
 */

// A timezone that observes DST, so the DST-adjacent test below actually
// crosses a spring-forward boundary rather than a no-op offset change.
process.env.TZ = "America/New_York";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let store: typeof import("@/server/settings/store");
let quota: typeof import("@/server/usage/quota");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  store = await import("@/server/settings/store");
  quota = await import("@/server/usage/quota");

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

/** Inserts a finished stage run costing `costUsd`, started at `startedAtMs`. */
function seedRun(costUsd: number, startedAtMs: number) {
  const task = service.createTask({
    repoId,
    title: "A task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
  service.updateStageRun(run.id, {
    status: "done",
    startedAt: startedAtMs,
    finishedAt: startedAtMs,
    costUsd,
  });
  return task;
}

beforeEach(() => {
  for (const task of service.listTasks()) service.deleteTask(task.id);
  store.updateSettings({
    quotaLimits: {
      subscription: { limitUsd: null, cadence: "daily" },
      api_key: { limitUsd: null, cadence: "daily" },
    },
  });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("periodStart / nextReset", () => {
  it("daily: starts at local midnight and resets at the next local midnight", () => {
    const now = new Date(2025, 5, 15, 14, 32, 0).getTime(); // 2025-06-15 14:32 local
    const start = quota.periodStart("daily", now);
    const reset = quota.nextReset("daily", now);

    const startDate = new Date(start);
    expect(startDate.getFullYear()).toBe(2025);
    expect(startDate.getMonth()).toBe(5);
    expect(startDate.getDate()).toBe(15);
    expect(startDate.getHours()).toBe(0);
    expect(startDate.getMinutes()).toBe(0);

    const resetDate = new Date(reset);
    expect(resetDate.getDate()).toBe(16);
    expect(resetDate.getHours()).toBe(0);
  });

  it("hourly: starts at the local top of the hour and resets at the next one", () => {
    const now = new Date(2025, 5, 15, 14, 32, 9).getTime();
    const start = quota.periodStart("hourly", now);
    const reset = quota.nextReset("hourly", now);

    const startDate = new Date(start);
    expect(startDate.getHours()).toBe(14);
    expect(startDate.getMinutes()).toBe(0);
    expect(startDate.getSeconds()).toBe(0);

    const resetDate = new Date(reset);
    expect(resetDate.getHours()).toBe(15);
    expect(resetDate.getMinutes()).toBe(0);
  });

  it("daily: a DST spring-forward day still resets to the next calendar day's midnight", () => {
    // 2024-03-10 is the US spring-forward date: 2:00 AM jumps to 3:00 AM.
    const now = new Date(2024, 2, 10, 1, 30, 0).getTime();
    const start = quota.periodStart("daily", now);
    const reset = quota.nextReset("daily", now);

    expect(new Date(start).getDate()).toBe(10);
    expect(new Date(start).getHours()).toBe(0);

    const resetDate = new Date(reset);
    expect(resetDate.getMonth()).toBe(2);
    expect(resetDate.getDate()).toBe(11);
    expect(resetDate.getHours()).toBe(0);
    // The wall-clock day is still 24h "long", but the DST-losing night means
    // only 23h actually elapse — proof `nextReset` advances by calendar day,
    // not by adding a fixed 86_400_000ms.
    expect(reset - start).toBe(23 * 60 * 60 * 1000);
  });
});

describe("spendToday", () => {
  it("sums only stage runs started today, across every task", () => {
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    const todayStart = quota.periodStart("daily", now);

    seedRun(1.5, todayStart + 60_000);
    seedRun(2.25, now);
    seedRun(9, todayStart - 60_000); // yesterday, just before midnight

    expect(quota.spendToday(now)).toBeCloseTo(3.75, 10);
  });

  it("is 0 when nothing has run today", () => {
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    expect(quota.spendToday(now)).toBe(0);
  });
});

describe("resolveQuotaStatus", () => {
  it("is not_configured when no Claude credential is set", () => {
    const status = quota.resolveQuotaStatus();
    expect(status.state).toBe("not_configured");
    expect(status.authMode).toBe("missing");
  });

  it("is not_configured when a credential is set but no limit is configured", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
    const status = quota.resolveQuotaStatus();
    expect(status.state).toBe("not_configured");
    expect(status.authMode).toBe("subscription");
  });

  it("is normal below 80% usage", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(7.9, now); // 79%

    const status = quota.resolveQuotaStatus(now);
    expect(status.state).toBe("normal");
    if (status.state !== "not_configured") {
      expect(status.usedUsd).toBeCloseTo(7.9, 10);
      expect(status.remainingUsd).toBeCloseTo(2.1, 10);
    }
  });

  it("is warning between 80% (inclusive) and 100% usage", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(8.5, now); // 85%

    expect(quota.resolveQuotaStatus(now).state).toBe("warning");
  });

  it("is exceeded at or above 100% usage, with remaining floored at 0", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(10.5, now); // 105%

    const status = quota.resolveQuotaStatus(now);
    expect(status.state).toBe("exceeded");
    if (status.state !== "not_configured") {
      expect(status.remainingUsd).toBe(0);
    }
  });

  it("switching cadence changes both the used-figure and the reset target", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    const now = new Date(2025, 5, 15, 10, 30, 0).getTime();
    const todayStart = quota.periodStart("daily", now);
    const hourStart = quota.periodStart("hourly", now); // 10:00

    seedRun(3, todayStart + 60_000); // 00:01 — today, but not this clock hour
    seedRun(5, hourStart + 60_000); // 10:01 — today and this clock hour

    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 100, cadence: "daily" } } });
    const daily = quota.resolveQuotaStatus(now);
    expect(daily.state === "not_configured" ? null : daily.usedUsd).toBeCloseTo(8, 10);
    expect(daily.state === "not_configured" ? null : daily.resetAt).toBe(
      quota.nextReset("daily", now),
    );

    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 100, cadence: "hourly" } } });
    const hourly = quota.resolveQuotaStatus(now);
    expect(hourly.state === "not_configured" ? null : hourly.resetAt).toBe(
      quota.nextReset("hourly", now),
    );
    expect(hourly.state === "not_configured" ? null : hourly.usedUsd).toBeCloseTo(5, 10);
  });
});
