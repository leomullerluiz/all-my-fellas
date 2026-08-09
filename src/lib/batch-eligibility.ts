import type { TaskStatus } from "@/server/pipeline/stages";

/**
 * Shared batch-selection eligibility (S4 —
 * `spec-board-at-scale.md` §7.2/§7.3), read by three places that must never
 * disagree: the board's checkbox (any task is selectable — the *verb*
 * decides what can actually be done), the batch action bar (which of
 * Start/Archive/Cancel to enable for the current selection), and
 * `BatchSelectionProvider`'s per-render pruning of a selected id that became
 * ineligible for every verb.
 */

export type BatchVerb = "start" | "archive" | "cancel";

/** The minimal task shape every eligibility check needs. */
export type BatchEligibilityTask = {
  status: TaskStatus;
  archivedAt?: number | null;
};

const CANCELLABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "running",
  "awaiting_gate",
  "on_queue",
  "gate_queued",
]);

/** Whether `task` is a valid target for `verb` right now. */
export function isBatchSelectable(task: BatchEligibilityTask, verb: BatchVerb): boolean {
  switch (verb) {
    case "start":
      // Same population `TaskCardMenu`'s Start item and `startTasksBatch`
      // already act on: a `CREATED` task not already parked at `on_queue`.
      return task.status === "queued";
    case "archive":
      return (task.archivedAt ?? null) === null;
    case "cancel":
      return CANCELLABLE_STATUSES.has(task.status);
  }
}

/** Whether `task` supports at least one batch verb — used to prune a stale selection. */
export function isBatchEligibleForAnyVerb(task: BatchEligibilityTask): boolean {
  return (
    isBatchSelectable(task, "start") ||
    isBatchSelectable(task, "archive") ||
    isBatchSelectable(task, "cancel")
  );
}
