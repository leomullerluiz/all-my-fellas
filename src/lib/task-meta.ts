import { formatRelativeAge } from "@/lib/utils";
import { STAGE_LABELS, type Stage, type TaskStatus } from "@/server/pipeline/stages";

/**
 * The board card's one-line meta string — S1 / `spec-board-at-scale.md` §3.1:
 * "how long" and "what next", derived from data the card already has plus
 * one aggregate query's worth of running-stage start times
 * (`activeStageRunStarts`). Pure and server/client-agnostic so it is
 * trivially unit-testable, same convention as `task-filter.ts`.
 */
export type TaskMetaInput = {
  status: TaskStatus;
  currentStage: Stage;
  createdAt: number;
  /**
   * `tasks.updated_at` — stamped by `updateTask` on every write, which
   * includes every stage/status transition (`setTaskStage`, gate decisions,
   * cancel, promotion into `on_queue`, …). Used as "time since entering the
   * current status" for every status except `CREATED`, where "how long"
   * means since creation, not since the last edit. Falls back to `createdAt`
   * when omitted, so existing callers/tests that only know `createdAt`
   * degrade to the pre-fix (created-at-based) behavior rather than crashing.
   */
  updatedAt?: number;
  /** Defaults to `Date.now()`; a fixed value keeps this pure for tests. */
  now?: number;
  /**
   * `stage_runs.started_at` of the currently-running stage run, from
   * `activeStageRunStarts()`. `null`/`undefined` when unknown — the elapsed
   * half of a `running` line is then omitted rather than guessed.
   */
  runningStageStartedAt?: number | null;
  /**
   * 1-based position in the On Queue column's real promotion order (S7) —
   * the caller computes this once for the whole column, not per card.
   * Omitted (or `null`) when not applicable/available.
   */
  queuePosition?: number | null;
};

export function taskMetaLine(input: TaskMetaInput): string {
  const now = input.now ?? Date.now();
  const createdAge = formatRelativeAge(now - input.createdAt);
  // Every status but `CREATED` reports time-in-current-status, not
  // time-since-creation — a task that ran for 3 hours before failing 5
  // minutes ago must read "failed · 5m ago", not "failed · ~3h ago".
  const age = formatRelativeAge(now - (input.updatedAt ?? input.createdAt));

  switch (input.status) {
    case "queued":
      return `created ${createdAge} ago`;
    case "on_queue":
      return input.queuePosition
        ? `queued ${age} ago · #${input.queuePosition} in queue`
        : `queued ${age} ago`;
    case "running": {
      const label = STAGE_LABELS[input.currentStage];
      if (input.runningStageStartedAt == null) return label;
      const elapsed = formatRelativeAge(now - input.runningStageStartedAt);
      return `${label} · ${elapsed}`;
    }
    case "awaiting_gate":
      return `waiting for you · ${age}`;
    case "gate_queued":
      return "approved · waiting for a slot";
    case "completed":
      return `completed · ${age} ago`;
    case "rejected":
      return `rejected · ${age} ago`;
    case "failed":
      return `failed · ${age} ago`;
    case "cancelled":
      return `cancelled · ${age} ago`;
  }
}
