import { PRIORITIES, TASK_STATUSES, type Priority, type TaskStatus } from "@/server/pipeline/stages";

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

/**
 * Statuses that are always shown, regardless of `createdAt` or any active
 * filter. Exported (S2) for the "Active" saved view, which is exactly this
 * set — see `saved-views.tsx`.
 */
export const OPEN_STATUSES: readonly TaskStatus[] = [
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
 * `"all"` is S2's explicit Reset state — distinct from the no-params default
 * (`defaultDateRange()`, "today"). Both are reachable: a bare `/` load falls
 * back to `defaultDateRange()`, while `?range=all` (what Reset now navigates
 * to) means "every task, every date" — see `task-filter-bar.tsx`'s `onReset`
 * and `page.tsx`'s param handling. Before this, Reset only ever produced
 * `defaultDateRange()` again, so "today" was both the default *and* the
 * widest thing Reset could show.
 */
export type DateRangeFilter = DateRange | "all";

/**
 * S1/S2: keeps every open/active-status task (any `createdAt`), plus every
 * other task whose `createdAt` falls inside `range` (today by default, or
 * the user's custom range once applied). `range === "all"` short-circuits to
 * every task, regardless of status or date.
 */
export function filterBoardTasks<T extends FilterableTask>(tasks: T[], range: DateRangeFilter): T[] {
  if (range === "all") return tasks;
  return tasks.filter((task) => {
    if (isOpenStatus(task.status)) return true;
    return task.createdAt >= range.startMs && task.createdAt <= range.endMs;
  });
}

/**
 * The board's structured filters (S2 §4.2), all URL-driven: `?q=`, `?repo=`,
 * `?priority=`, `?status=`. Composed with the date range separately (§4.2's
 * "SQL narrows the candidate set, then `filterBoardTasks` applies the
 * date/open-status rule to what's left" — see `techplan.md`'s risk note on
 * getting that order right).
 */
export type ListFilters = {
  q?: string;
  repoId?: string;
  priority?: Priority;
  status?: TaskStatus;
};

/**
 * Parses `page.tsx`'s raw `searchParams` into {@link ListFilters}, silently
 * dropping anything invalid (an unknown `priority`/`status` value, an
 * empty/whitespace-only `q`) rather than erroring — the board is a view
 * convenience, not an API contract, matching `parseDateRangeParams`'s own
 * "fall back rather than 400" convention. `GET /api/tasks`'s
 * `listTasksQuerySchema` is the strict counterpart for the actual API
 * surface.
 */
export function parseListFilters(
  params: Record<string, string | string[] | undefined>,
): ListFilters {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const q = first(params.q)?.trim();
  const repoId = first(params.repo)?.trim();
  const priorityRaw = first(params.priority);
  const statusRaw = first(params.status);

  const filters: ListFilters = {};
  if (q) filters.q = q;
  if (repoId) filters.repoId = repoId;
  if (priorityRaw && (PRIORITIES as readonly string[]).includes(priorityRaw)) {
    filters.priority = priorityRaw as Priority;
  }
  if (statusRaw && (TASK_STATUSES as readonly string[]).includes(statusRaw)) {
    filters.status = statusRaw as TaskStatus;
  }
  return filters;
}
