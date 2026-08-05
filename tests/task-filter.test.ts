import { describe, expect, it } from "vitest";

import {
  defaultDateRange,
  filterBoardTasks,
  parseDateRangeParams,
  type FilterableTask,
} from "@/lib/task-filter";

/**
 * S1/S2 — the board's default "today + open tasks" view, and a custom
 * date-range override. See `src/components/task-board.tsx` for how
 * `COMPLETED`/`REJECTED`/`FAILED`/`CANCELLED` map onto the "Completed" and
 * "Not delivered" columns this feature filters.
 */

function task(overrides: Partial<FilterableTask> = {}): FilterableTask {
  return { status: "completed", createdAt: 0, ...overrides };
}

describe("defaultDateRange", () => {
  it("spans local midnight to 23:59:59.999 of the same calendar day", () => {
    const now = new Date(2026, 7, 5, 14, 32, 0).getTime(); // 2026-08-05 14:32 local
    const range = defaultDateRange(now);

    const start = new Date(range.startMs);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(7);
    expect(start.getDate()).toBe(5);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);

    const end = new Date(range.endMs);
    expect(end.getDate()).toBe(5);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
  });
});

describe("parseDateRangeParams", () => {
  it("parses a valid start/end pair into an inclusive day-boundary range", () => {
    const range = parseDateRangeParams("2026-01-03", "2026-01-07");
    expect(range).not.toBeNull();
    expect(new Date(range!.startMs).getDate()).toBe(3);
    expect(new Date(range!.startMs).getHours()).toBe(0);
    expect(new Date(range!.endMs).getDate()).toBe(7);
    expect(new Date(range!.endMs).getHours()).toBe(23);
  });

  it("returns null when either param is missing", () => {
    expect(parseDateRangeParams(null, "2026-01-07")).toBeNull();
    expect(parseDateRangeParams("2026-01-03", undefined)).toBeNull();
    expect(parseDateRangeParams(null, null)).toBeNull();
  });

  it("returns null when end is before start", () => {
    expect(parseDateRangeParams("2026-01-07", "2026-01-03")).toBeNull();
  });

  it("returns null for an unparseable date string", () => {
    expect(parseDateRangeParams("not-a-date", "2026-01-07")).toBeNull();
  });

  it("accepts a same-day range", () => {
    const range = parseDateRangeParams("2026-01-05", "2026-01-05");
    expect(range).not.toBeNull();
  });
});

describe("filterBoardTasks", () => {
  it("excludes a yesterday-dated COMPLETED task from the default range", () => {
    const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
    const range = defaultDateRange(now);
    const yesterday = new Date(2026, 7, 4, 10, 0, 0).getTime();

    const result = filterBoardTasks([task({ status: "completed", createdAt: yesterday })], range);
    expect(result).toHaveLength(0);
  });

  it("includes a today-dated COMPLETED task in the default range", () => {
    const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
    const range = defaultDateRange(now);
    const today = new Date(2026, 7, 5, 9, 0, 0).getTime();

    const result = filterBoardTasks([task({ status: "completed", createdAt: today })], range);
    expect(result).toHaveLength(1);
  });

  it("includes a yesterday-dated running task regardless of the range", () => {
    const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
    const range = defaultDateRange(now);
    const yesterday = new Date(2026, 7, 4, 10, 0, 0).getTime();

    const result = filterBoardTasks([task({ status: "running", createdAt: yesterday })], range);
    expect(result).toHaveLength(1);
  });

  it("includes every open status regardless of createdAt", () => {
    const range = defaultDateRange(new Date(2026, 7, 5, 12, 0, 0).getTime());
    const ancient = new Date(2020, 0, 1).getTime();

    for (const status of ["queued", "on_queue", "running", "awaiting_gate", "gate_queued"] as const) {
      const result = filterBoardTasks([task({ status, createdAt: ancient })], range);
      expect(result).toHaveLength(1);
    }
  });

  it("with a custom range, shows a REJECTED/FAILED/CANCELLED task inside it and hides one outside it", () => {
    const range = parseDateRangeParams("2026-01-03", "2026-01-07")!;
    const inside = new Date(2026, 0, 5, 10, 0, 0).getTime();
    const outside = new Date(2026, 0, 10, 10, 0, 0).getTime();

    expect(
      filterBoardTasks([task({ status: "rejected", createdAt: inside })], range),
    ).toHaveLength(1);
    expect(
      filterBoardTasks([task({ status: "failed", createdAt: outside })], range),
    ).toHaveLength(0);
    expect(
      filterBoardTasks([task({ status: "cancelled", createdAt: outside })], range),
    ).toHaveLength(0);
  });

  it("with a custom range, still shows open-status tasks outside the range", () => {
    const range = parseDateRangeParams("2026-01-03", "2026-01-07")!;
    const outside = new Date(2026, 0, 20, 10, 0, 0).getTime();

    const result = filterBoardTasks([task({ status: "awaiting_gate", createdAt: outside })], range);
    expect(result).toHaveLength(1);
  });

  it("range boundaries are inclusive", () => {
    const range = parseDateRangeParams("2026-01-03", "2026-01-07")!;

    expect(
      filterBoardTasks([task({ status: "completed", createdAt: range.startMs })], range),
    ).toHaveLength(1);
    expect(
      filterBoardTasks([task({ status: "completed", createdAt: range.endMs })], range),
    ).toHaveLength(1);
  });
});
