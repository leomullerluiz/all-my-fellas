import type { TaskStatus } from "@/server/pipeline/stages";

/**
 * Dashboard board date filtering (S1/S2/S3).
 *
 * The board's default view hides old `COMPLETED`/`REJECTED`/`FAILED`/
 * `CANCELLED` tasks so the kanban isn't cluttered with weeks of finished
 * work, while never hiding a task that's still open or active regardless of
 * how old it is. A user can widen the window with an explicit date range.
 *
 * This module is pure (no server-only imports, no `Date.now()` default
 * baked into the exported functions beyond an explicit `now` parameter) so
 * it stays trivially unit-testable, matching `quota.ts`'s `periodStart`.
 */

/** Statuses that are always shown, regardless of `createdAt` or any active filter. */
const OPEN_STATUSES: readonly TaskStatus[] = [
  "queued",
  "on_queue",
  "running",
  "awaiting_gate",
  "gate_queued",
];

export function isOpenStatus(status: TaskStatus): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** Inclusive `[startMs, endMs]` window a completed/undelivered task's `createdAt` must fall in. */
export type DateRange = { startMs: number; endMs: number };

/**
 * S1's default window: local-calendar "today", start to end.
 *
 * Local server time, same convention as `quota.ts`'s `periodStart` — do not
 * switch this to `Date.UTC`, that would silently change what "today" means
 * for whoever is looking at the board.
 */
export function defaultDateRange(now: number = Date.now()): DateRange {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/**
 * Parses `?start=YYYY-MM-DD&end=YYYY-MM-DD` search params into a `DateRange`.
 *
 * Returns `null` when either param is missing, unparseable, or `end` is
 * earlier than `start` — the caller falls back to `defaultDateRange` in every
 * one of those cases, matching S2's "invalid range keeps the previous/default
 * filter in effect" acceptance criterion.
 */
export function parseDateRangeParams(
  start: string | null | undefined,
  end: string | null | undefined,
): DateRange | null {
  if (!start || !end) return null;

  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T23:59:59.999`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  if (endDate.getTime() < startDate.getTime()) return null;

  return { startMs: startDate.getTime(), endMs: endDate.getTime() };
}

/** The minimal shape `filterBoardTasks` needs from a board task. */
export type FilterableTask = { status: TaskStatus; createdAt: number };

/**
 * S1/S2: keeps every open/active-status task (any `createdAt`), plus every
 * other task whose `createdAt` falls inside `range` (today by default, or
 * the user's custom range once applied).
 */
export function filterBoardTasks<T extends FilterableTask>(tasks: T[], range: DateRange): T[] {
  return tasks.filter((task) => {
    if (isOpenStatus(task.status)) return true;
    return task.createdAt >= range.startMs && task.createdAt <= range.endMs;
  });
}
