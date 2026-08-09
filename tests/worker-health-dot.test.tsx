// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerHealthDot } from "@/components/worker-health-dot";
import type { WorkerHealth } from "@/server/worker/health";

/**
 * S5 — the nav dot renders the derived worker health state (§7.4). Only the
 * initial-render mapping is exercised here (green/amber/red/grey per state,
 * with the state and lag surfaced in `title`); the polling refresh is a
 * `setInterval`+`fetch` wrapper with nothing state-machine-shaped to assert
 * beyond what `resolveWorkerHealth`'s own tests (`tests/health.test.ts`)
 * already cover.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function health(overrides: Partial<WorkerHealth>): WorkerHealth {
  return { state: "healthy", lagMs: 500, activeTaskId: null, interrupted: false, ...overrides };
}

describe("WorkerHealthDot", () => {
  it("renders green for healthy", () => {
    render(<WorkerHealthDot initialHealth={health({ state: "healthy" })} />);
    const dot = screen.getByTitle(/worker healthy/i);
    expect(dot.getAttribute("data-health-state")).toBe("healthy");
    expect(dot.className).toContain("bg-success");
  });

  it("renders amber for lagging", () => {
    render(<WorkerHealthDot initialHealth={health({ state: "lagging" })} />);
    const dot = screen.getByTitle(/worker lagging/i);
    expect(dot.getAttribute("data-health-state")).toBe("lagging");
    expect(dot.className).toContain("bg-warning");
  });

  it("renders red for stale", () => {
    render(<WorkerHealthDot initialHealth={health({ state: "stale", lagMs: 90_000 })} />);
    const dot = screen.getByTitle(/worker stale/i);
    expect(dot.getAttribute("data-health-state")).toBe("stale");
    expect(dot.className).toContain("bg-danger");
  });

  it("renders grey for never_started, with no lag in the title", () => {
    render(<WorkerHealthDot initialHealth={health({ state: "never_started", lagMs: null })} />);
    const dot = screen.getByTitle(/worker never started/i);
    expect(dot.getAttribute("data-health-state")).toBe("never_started");
    expect(dot.className).toContain("bg-muted");
    expect(dot.getAttribute("title")).not.toMatch(/last heartbeat/);
  });

  it("names the interrupted task in the title when stale and holding one", () => {
    render(
      <WorkerHealthDot
        initialHealth={health({ state: "stale", lagMs: 90_000, activeTaskId: "task_42", interrupted: true })}
      />,
    );
    const dot = screen.getByTitle(/died mid-stage/i);
    expect(dot.getAttribute("title")).toContain("task_42");
  });
});
