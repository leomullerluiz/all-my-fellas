import { sql } from "drizzle-orm";

import { tasks, type TaskRow } from "../db/schema";

/**
 * The single definition of "priority descending, difficulty ascending" —
 * shared by `claimNextJob` (which stage-run job to claim next), the
 * orchestrator's batch/promotion paths (`startTasksBatch`, `promoteQueue`),
 * and the board's On Queue column (`spec-board-at-scale.md` §8.2). Before
 * this module the rule existed twice — as SQL here and as a JS lookup table
 * in `orchestrator.ts` — and the board would have made it a third,
 * independently-drifting copy.
 *
 * `difficulty` is set by the Architect, so a freshly created task has `NULL`.
 * It sorts with `M` — neutral — rather than last, which would starve
 * un-estimated work behind anything already estimated.
 */
export const PRIORITY_RANK = sql`CASE ${tasks.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export const DIFFICULTY_RANK = sql`CASE ${tasks.difficulty}
  WHEN 'S' THEN 0 WHEN 'L' THEN 2 ELSE 1 END`;

const PRIORITY_RANK_JS: Record<TaskRow["priority"], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DIFFICULTY_RANK_JS: Record<string, number> = { S: 0, M: 1, L: 2 };

function difficultyRankJs(difficulty: TaskRow["difficulty"]): number {
  return difficulty ? (DIFFICULTY_RANK_JS[difficulty] ?? 1) : 1;
}

/**
 * Priority-descending, difficulty-ascending comparator over already-fetched
 * rows — the JS mirror of {@link PRIORITY_RANK}/{@link DIFFICULTY_RANK}.
 * Ties are left in their incoming order; callers that need an oldest-first
 * tiebreak (queue promotion, the On Queue column) pre-sort by `updatedAt`
 * before calling this, since `Array.prototype.sort` is stable.
 */
export function compareByPriorityThenDifficulty(a: TaskRow, b: TaskRow): number {
  const priorityDelta = PRIORITY_RANK_JS[a.priority] - PRIORITY_RANK_JS[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return difficultyRankJs(a.difficulty) - difficultyRankJs(b.difficulty);
}

/** Sorts a copy of `tasksToSort` by {@link compareByPriorityThenDifficulty}. */
export function sortByPriorityThenDifficulty<T extends TaskRow>(tasksToSort: T[]): T[] {
  return [...tasksToSort].sort(compareByPriorityThenDifficulty);
}
