import { describe, expect, it } from "vitest";

import { taskMetaLine } from "@/lib/task-meta";

/**
 * S1 §3.1 — the board card's one-line meta string, one branch per task
 * state per the spec's table.
 */

const NOW = new Date(2026, 7, 5, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

describe("taskMetaLine", () => {
  it("CREATED: 'created {age} ago'", () => {
    const line = taskMetaLine({
      status: "queued",
      currentStage: "CREATED",
      createdAt: NOW - 2 * HOUR,
      now: NOW,
    });
    expect(line).toBe("created 2h ago");
  });

  it("on_queue: 'queued {age} ago · #{position} in queue'", () => {
    const line = taskMetaLine({
      status: "on_queue",
      currentStage: "CREATED",
      createdAt: NOW - 2 * HOUR,
      now: NOW,
      queuePosition: 3,
    });
    expect(line).toBe("queued 2h ago · #3 in queue");
  });

  it("on_queue without a known position omits the '#N in queue' half", () => {
    const line = taskMetaLine({
      status: "on_queue",
      currentStage: "CREATED",
      createdAt: NOW - 2 * HOUR,
      now: NOW,
      queuePosition: null,
    });
    expect(line).toBe("queued 2h ago");
  });

  it("running: '{stage label} · {elapsed}'", () => {
    const line = taskMetaLine({
      status: "running",
      currentStage: "DEVELOPMENT",
      createdAt: NOW - 3 * HOUR,
      now: NOW,
      runningStageStartedAt: NOW - 14 * 60_000,
    });
    expect(line).toBe("Developer · 14m");
  });

  it("running with no known start time falls back to just the stage label", () => {
    const line = taskMetaLine({
      status: "running",
      currentStage: "DEVELOPMENT",
      createdAt: NOW - 3 * HOUR,
      now: NOW,
      runningStageStartedAt: null,
    });
    expect(line).toBe("Developer");
  });

  it("awaiting_gate: 'waiting for you · {age}'", () => {
    const line = taskMetaLine({
      status: "awaiting_gate",
      currentStage: "PLAN_GATE",
      createdAt: NOW - 2 * 24 * HOUR,
      now: NOW,
    });
    expect(line).toBe("waiting for you · 2d");
  });

  it("gate_queued: 'approved · waiting for a slot'", () => {
    const line = taskMetaLine({
      status: "gate_queued",
      currentStage: "PLAN_GATE",
      createdAt: NOW - HOUR,
      now: NOW,
    });
    expect(line).toBe("approved · waiting for a slot");
  });

  it.each([
    ["failed", "failed"],
    ["rejected", "rejected"],
    ["cancelled", "cancelled"],
  ] as const)("terminal (%s): '%s · {age} ago'", (status, word) => {
    const line = taskMetaLine({
      status,
      currentStage: "CREATED",
      createdAt: NOW - 3 * HOUR,
      now: NOW,
    });
    expect(line).toBe(`${word} · 3h ago`);
  });

  it("completed also reports its age, for consistency with the other terminal states", () => {
    const line = taskMetaLine({
      status: "completed",
      currentStage: "COMPLETED",
      createdAt: NOW - 3 * HOUR,
      now: NOW,
    });
    expect(line).toBe("completed · 3h ago");
  });
});
