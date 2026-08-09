import { describe, expect, it } from "vitest";

import type { WorkerStatusRow } from "@/server/db/schema";
import { deriveWorkerHealth, WORKER_TICK_MS } from "@/server/worker/health";

/**
 * S5 — the boundaries in §7.3's table: no row, within the healthy window,
 * into `lagging`, into `stale`, and the `interrupted` flag a `stale` row
 * with an `active_task_id` carries.
 */

function row(overrides: Partial<WorkerStatusRow>): WorkerStatusRow {
  return {
    id: "worker",
    startedAt: 0,
    heartbeatAt: 0,
    pid: 123,
    version: "0.1.0",
    activeJobId: null,
    activeTaskId: null,
    ...overrides,
  };
}

describe("deriveWorkerHealth", () => {
  const now = 1_000_000;

  it("is 'never_started' when no row exists", () => {
    const health = deriveWorkerHealth(null, now);
    expect(health.state).toBe("never_started");
    expect(health.lagMs).toBeNull();
    expect(health.interrupted).toBe(false);
  });

  it("is 'healthy' within 3x the tick interval", () => {
    const health = deriveWorkerHealth(row({ heartbeatAt: now - 3 * WORKER_TICK_MS }), now);
    expect(health.state).toBe("healthy");
  });

  it("is 'lagging' past 3x the tick interval but within 60s", () => {
    const health = deriveWorkerHealth(row({ heartbeatAt: now - 3 * WORKER_TICK_MS - 1 }), now);
    expect(health.state).toBe("lagging");

    const atBoundary = deriveWorkerHealth(row({ heartbeatAt: now - 60_000 }), now);
    expect(atBoundary.state).toBe("lagging");
  });

  it("is 'stale' past 60s", () => {
    const health = deriveWorkerHealth(row({ heartbeatAt: now - 60_001 }), now);
    expect(health.state).toBe("stale");
  });

  it("marks a stale row with an active_task_id as interrupted", () => {
    const health = deriveWorkerHealth(row({ heartbeatAt: now - 120_000, activeTaskId: "task_1" }), now);
    expect(health.state).toBe("stale");
    expect(health.interrupted).toBe(true);
    expect(health.activeTaskId).toBe("task_1");
  });

  it("does not mark a stale row with no active task as interrupted", () => {
    const health = deriveWorkerHealth(row({ heartbeatAt: now - 120_000, activeTaskId: null }), now);
    expect(health.state).toBe("stale");
    expect(health.interrupted).toBe(false);
  });

  it("does not mark a lagging row as interrupted even with an active task", () => {
    const health = deriveWorkerHealth(row({ heartbeatAt: now - 30_000, activeTaskId: "task_1" }), now);
    expect(health.state).toBe("lagging");
    expect(health.interrupted).toBe(false);
  });
});
