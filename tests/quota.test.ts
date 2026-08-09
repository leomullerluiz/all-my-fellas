import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Usage-quota math for the dashboard's bottom bar.
 *
 * - `periodStart`/`nextReset` — S2's daily-midnight/hourly-top-of-hour
 *   boundaries and S4's monthly boundary, computed in local server time (see
 *   `quota.ts`'s DST note).
 * - `resolveQuotaStatus` — S2's per-provider segmentation and S3's 80%/100%
 *   warning thresholds (S4: threshold now configurable via `warningRatio`).
 * - `resolveEnforcementQuotaStatus` — the pool-wide, Claude-mode-keyed
 *   computation `assertWithinQuota` still relies on, unaffected by S2.
 * - `costSince`'s provider filter, exercised here rather than in
 *   `tests/settings.test.ts` since quota is its main consumer.
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
function seedRun(
  costUsd: number,
  startedAtMs: number,
  provider?: "claude" | "chatgpt" | "gemini",
) {
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
    ...(provider ? { provider } : {}),
  });
  return task;
}

beforeEach(() => {
  for (const task of service.listTasks()) service.deleteTask(task.id);
  store.updateSettings({
    quotaLimits: {
      subscription: { limitUsd: null, cadence: "daily" },
      api_key: { limitUsd: null, cadence: "daily" },
      chatgpt: { limitUsd: null, cadence: "daily" },
      gemini: { limitUsd: null, cadence: "daily" },
    },
    warningRatio: 0.8,
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

  describe("monthly (S4)", () => {
    it("starts at the 1st of the month at local midnight", () => {
      const now = new Date(2025, 5, 15, 14, 32, 0).getTime(); // June 2025
      const start = quota.periodStart("monthly", now);
      const startDate = new Date(start);
      expect(startDate.getMonth()).toBe(5);
      expect(startDate.getDate()).toBe(1);
      expect(startDate.getHours()).toBe(0);
    });

    it("resets at the 1st of the next month — a 28-day February", () => {
      const now = new Date(2025, 1, 10).getTime(); // Feb 2025 (28 days, not a leap year)
      const reset = quota.nextReset("monthly", now);
      const resetDate = new Date(reset);
      expect(resetDate.getMonth()).toBe(2); // March
      expect(resetDate.getDate()).toBe(1);
    });

    it("resets at the 1st of the next month — a 30-day April", () => {
      const now = new Date(2025, 3, 10).getTime(); // April (30 days)
      const reset = quota.nextReset("monthly", now);
      const resetDate = new Date(reset);
      expect(resetDate.getMonth()).toBe(4); // May
      expect(resetDate.getDate()).toBe(1);
    });

    it("resets at the 1st of the next month — a 31-day January", () => {
      const now = new Date(2025, 0, 10).getTime(); // January (31 days)
      const reset = quota.nextReset("monthly", now);
      const resetDate = new Date(reset);
      expect(resetDate.getMonth()).toBe(1); // February
      expect(resetDate.getDate()).toBe(1);
    });

    it("resets across December into January of the next year", () => {
      const now = new Date(2025, 11, 20).getTime();
      const reset = quota.nextReset("monthly", now);
      const resetDate = new Date(reset);
      expect(resetDate.getFullYear()).toBe(2026);
      expect(resetDate.getMonth()).toBe(0);
      expect(resetDate.getDate()).toBe(1);
    });

    it("starts and resets correctly across the DST spring-forward date", () => {
      const now = new Date(2024, 2, 10, 1, 30, 0).getTime(); // March 2024
      const start = quota.periodStart("monthly", now);
      expect(new Date(start).getDate()).toBe(1);
      expect(new Date(start).getMonth()).toBe(2);

      const reset = quota.nextReset("monthly", now);
      expect(new Date(reset).getMonth()).toBe(3);
      expect(new Date(reset).getDate()).toBe(1);
    });
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

describe("resolveEnforcementQuotaStatus — pool-wide, Claude-mode-keyed (unaffected by S2)", () => {
  it("is not_configured when no Claude credential is set", () => {
    const status = quota.resolveEnforcementQuotaStatus();
    expect(status.state).toBe("not_configured");
    expect(status.authMode).toBe("missing");
  });

  it("is not_configured when a credential is set but no limit is configured", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
    const status = quota.resolveEnforcementQuotaStatus();
    expect(status.state).toBe("not_configured");
    expect(status.authMode).toBe("subscription");
  });

  it("is normal below the warning threshold", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(7.9, now); // 79%

    const status = quota.resolveEnforcementQuotaStatus(now);
    expect(status.state).toBe("normal");
    if (status.state !== "not_configured") {
      expect(status.usedUsd).toBeCloseTo(7.9, 10);
      expect(status.remainingUsd).toBeCloseTo(2.1, 10);
    }
  });

  it("is warning between the threshold (inclusive) and 100% usage", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(8.5, now); // 85%

    expect(quota.resolveEnforcementQuotaStatus(now).state).toBe("warning");
  });

  it("is exceeded at or above 100% usage, with remaining floored at 0", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(10.5, now); // 105%

    const status = quota.resolveEnforcementQuotaStatus(now);
    expect(status.state).toBe("exceeded");
    if (status.state !== "not_configured") {
      expect(status.remainingUsd).toBe(0);
    }
  });

  it("counts spend from every provider, not just Claude's — the documented pool-wide gap", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(4, now, "claude");
    seedRun(4, now, "gemini");

    const status = quota.resolveEnforcementQuotaStatus(now);
    expect(status.state === "not_configured" ? null : status.usedUsd).toBeCloseTo(8, 10);
  });
});

describe("resolveQuotaStatus — per-provider (S2)", () => {
  it("is an empty array when no Claude credential is set and nothing is configured", () => {
    expect(quota.resolveQuotaStatus()).toEqual([]);
  });

  it("omits Claude entirely when a credential is set but no limit is configured", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
    expect(quota.resolveQuotaStatus()).toEqual([]);
  });

  it("segments spend: gemini spend does not count against chatgpt's limit", () => {
    store.updateSettings({
      quotaLimits: {
        chatgpt: { limitUsd: 10, cadence: "daily" },
        gemini: { limitUsd: 10, cadence: "daily" },
      },
    });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(4, now, "chatgpt");
    seedRun(10.5, now, "gemini");

    const statuses = quota.resolveQuotaStatus(now);
    const chatgpt = statuses.find((status) => status.provider === "chatgpt");
    const gemini = statuses.find((status) => status.provider === "gemini");
    expect(chatgpt?.usedUsd).toBeCloseTo(4, 10);
    expect(gemini?.usedUsd).toBeCloseTo(10.5, 10);
    expect(gemini?.state).toBe("exceeded");
    expect(chatgpt?.state).toBe("normal");
  });

  it("a NULL-provider historical row counts against Claude, not against chatgpt/gemini", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({
      quotaLimits: {
        api_key: { limitUsd: 10, cadence: "daily" },
        chatgpt: { limitUsd: 10, cadence: "daily" },
      },
    });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(5, now); // no provider recorded — a pre-provenance row

    const statuses = quota.resolveQuotaStatus(now);
    const claude = statuses.find((status) => status.provider === "claude");
    const chatgpt = statuses.find((status) => status.provider === "chatgpt");
    expect(claude?.usedUsd).toBeCloseTo(5, 10);
    expect(chatgpt?.usedUsd).toBe(0);
  });

  it("shows a chatgpt status with no Claude credential present — not omitted, not not_configured", () => {
    // No CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY set — resolveProviderAuth().mode === "missing".
    store.updateSettings({ quotaLimits: { chatgpt: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(2, now, "chatgpt");

    const statuses = quota.resolveQuotaStatus(now);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].provider).toBe("chatgpt");
    expect(statuses[0].state).toBe("normal");
  });

  it("omits a provider with no limit configured, rather than including it at 0/0", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const statuses = quota.resolveQuotaStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses.some((status) => status.provider === "chatgpt")).toBe(false);
    expect(statuses.some((status) => status.provider === "gemini")).toBe(false);
  });

  it("reads a legacy quotaLimits blob (only subscription/api_key) without error", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    // Simulates a settings row written before chatgpt/gemini existed.
    store.updateSettings({
      quotaLimits: {
        subscription: { limitUsd: null, cadence: "daily" },
        api_key: { limitUsd: 25, cadence: "daily" },
      } as never,
    });

    const settings = store.getSettings();
    expect(settings.quotaLimits.api_key.limitUsd).toBe(25);
    expect(settings.quotaLimits.chatgpt.limitUsd).toBeNull();
    expect(settings.quotaLimits.gemini.limitUsd).toBeNull();

    expect(() => quota.resolveQuotaStatus()).not.toThrow();
  });

  it("switching cadence changes both the used-figure and the reset target", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    const now = new Date(2025, 5, 15, 10, 30, 0).getTime();
    const todayStart = quota.periodStart("daily", now);
    const hourStart = quota.periodStart("hourly", now); // 10:00

    seedRun(3, todayStart + 60_000, "claude"); // 00:01 — today, but not this clock hour
    seedRun(5, hourStart + 60_000, "claude"); // 10:01 — today and this clock hour

    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 100, cadence: "daily" } } });
    const daily = quota.resolveQuotaStatus(now)[0];
    expect(daily.usedUsd).toBeCloseTo(8, 10);
    expect(daily.resetAt).toBe(quota.nextReset("daily", now));

    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 100, cadence: "hourly" } } });
    const hourly = quota.resolveQuotaStatus(now)[0];
    expect(hourly.resetAt).toBe(quota.nextReset("hourly", now));
    expect(hourly.usedUsd).toBeCloseTo(5, 10);
  });
});

describe("warningRatio (S4)", () => {
  it("shows warning at 85% under the default 0.8 ratio", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(8.5, now, "claude");

    expect(quota.resolveQuotaStatus(now)[0].state).toBe("warning");
  });

  it("shows normal at 85% once warningRatio is raised to 0.9", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    store.updateSettings({
      quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } },
      warningRatio: 0.9,
    });
    const now = new Date(2025, 5, 15, 10, 0, 0).getTime();
    seedRun(8.5, now, "claude");

    expect(quota.resolveQuotaStatus(now)[0].state).toBe("normal");
  });
});

describe("costSince — provider filter (S2)", () => {
  it("with no provider, sums every stage run regardless of provenance", () => {
    const now = Date.now();
    seedRun(1, now, "claude");
    seedRun(2, now, "chatgpt");
    seedRun(3, now); // NULL provenance
    expect(service.costSince(0)).toBeCloseTo(6, 10);
  });

  it("'claude' includes NULL-provider rows", () => {
    const now = Date.now();
    seedRun(1, now, "claude");
    seedRun(3, now); // NULL provenance — pre-provider-column history
    expect(service.costSince(0, "claude")).toBeCloseTo(4, 10);
  });

  it("'chatgpt' and 'gemini' exclude NULL-provider rows", () => {
    const now = Date.now();
    seedRun(1, now, "chatgpt");
    seedRun(3, now); // NULL provenance
    expect(service.costSince(0, "chatgpt")).toBeCloseTo(1, 10);
    expect(service.costSince(0, "gemini")).toBe(0);
  });
});
