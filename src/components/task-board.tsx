"use client";

import Link from "next/link";

import { TaskSelectCheckbox } from "@/components/batch-start";
import { ClosedTaskCardMenu } from "@/components/closed-task-card-menu";
import { ExecutionDot } from "@/components/execution-dot";
import {
  TaskCardMenu,
  type CardMenuCapacity,
  type CardMenuDependency,
} from "@/components/task-card-menu";
import { Badge } from "@/components/ui/badge";
import { capacityBlockedReason } from "@/lib/capacity";
import { executionCopy } from "@/lib/execution-copy";
import { taskMetaLine } from "@/lib/task-meta";
import { currentTimeMs, formatCost } from "@/lib/utils";
import { isSlow } from "@/server/pipeline/stage-duration";
import { BOARD_STAGES, STAGE_LABELS, statusForStage, type Stage } from "@/server/pipeline/stages";
// Type-only: `execution.ts` imports `db`, which cannot be bundled for the
// browser, but a type-only import is erased before bundling — the same
// pattern `task-actions.tsx` already uses for `RetryAvailability`.
import type { ExecutionState } from "@/server/pipeline/execution";
import type { TaskWithRepo } from "@/server/tasks/service";

/** One card on the board. */
export type BoardTask = TaskWithRepo & {
  costUsd: number;
  dependsOn: CardMenuDependency[];
  execution: ExecutionState;
  /** `stage_runs.started_at` of the currently-running stage run, if any — S1's elapsed time. */
  runningStageStartedAt: number | null;
  /** 1-based position in the real promotion order (S7); `null` outside `on_queue`. */
  queuePosition: number | null;
};

const PRIORITY_TONE = {
  low: "neutral",
  medium: "neutral",
  high: "warning",
  urgent: "danger",
} as const;

const CLOSED_LABEL: Record<string, string> = {
  REJECTED: "rejected",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/** `failureReason` truncated for the card; the full text is the `title` tooltip (S1 §3.3). */
function truncateReason(reason: string, max = 70): string {
  if (reason.length <= max) return reason;
  return `${reason.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One card.
 *
 * The card is not a link. Only the title navigates, so the action menu can be a
 * sibling of the anchor rather than a `<button>` nested inside one — see
 * `spec-task-queue.md` §5.1. The generous padding on the title link keeps the
 * hit area the full height of the header row rather than just the glyphs.
 */
function TaskCard({
  task,
  capacity,
  maxJobAttempts,
  now,
}: {
  task: BoardTask;
  capacity: CardMenuCapacity;
  maxJobAttempts: number;
  /** A single `Date.now()` read for the whole board render — see `TaskBoard`. */
  now: number;
}) {
  const needsAttention = task.status === "awaiting_gate";
  const isGateQueued = task.status === "gate_queued";
  const notStarted = task.currentStage === "CREATED";
  // Every card shown under "Not delivered" — rejected, failed, or cancelled
  // alike — gets the "Move to Created" menu instead of a plain indicator.
  const isClosed = ["REJECTED", "FAILED", "CANCELLED"].includes(task.currentStage);
  // A single admitted task's own not-yet-claimed job is not a queue — it is
  // the ordinary sub-second gap before the next worker tick. Only show queue
  // wording once there is genuine contention for the worker, which requires
  // `maxParallelTasks > 1` in the first place (`capacity.limit` is that
  // setting) — see `spec-execution-honesty.md` §4.5 / stories.md S1.
  const showQueuePosition = capacity.limit > 1;
  const execution =
    task.execution.kind === "waiting_for_worker" && !showQueuePosition
      ? null
      : executionCopy(task.execution, maxJobAttempts);

  const metaLine = taskMetaLine({
    status: task.status,
    currentStage: task.currentStage,
    createdAt: task.createdAt,
    now,
    runningStageStartedAt: task.runningStageStartedAt,
    queuePosition: task.queuePosition,
  });
  const slow =
    task.status === "running" &&
    task.runningStageStartedAt !== null &&
    isSlow(task.currentStage, task.runningStageStartedAt, now);

  return (
    <div className="rounded-md border border-border bg-surface-raised p-2.5 transition-colors focus-within:border-accent/60 hover:border-accent/60">
      <div className="flex items-start justify-between gap-1.5">
        {/* `min-w-0` + `break-words` so a long unbroken title cannot widen the
            grid column and reintroduce horizontal overflow. */}
        <h3 className="min-w-0 break-words text-sm font-medium leading-snug">
          <Link
            href={`/tasks/${task.id}`}
            className="-my-0.5 block py-0.5 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {task.title}
          </Link>
        </h3>

        <div className="flex shrink-0 items-start gap-1">
          <TaskSelectCheckbox taskId={task.id} taskTitle={task.title} />
          {notStarted ? (
            <TaskCardMenu
              taskId={task.id}
              taskTitle={task.title}
              status={task.status}
              capacity={capacity}
              dependsOn={task.dependsOn}
            />
          ) : execution ? (
            <ExecutionDot className="mt-1" copy={execution} />
          ) : task.status === "running" ? (
            // Only reachable when queue wording is suppressed (`!showQueuePosition`)
            // for a task in the sub-second gap before the worker's next tick —
            // see the comment above. Every other branch always renders some
            // indicator; a card with none would read as its own, smaller lie.
            <span
              className="mt-1 inline-block size-2 shrink-0 rounded-full bg-accent"
              title="Admitted"
              aria-label="Admitted"
            />
          ) : needsAttention ? (
            <span
              className="mt-1 inline-block size-2 shrink-0 rounded-full bg-warning"
              title="Waiting for your approval"
              aria-label="Waiting for your approval"
            />
          ) : isGateQueued ? (
            <span
              className="mt-1 inline-block size-2 shrink-0 rounded-full bg-muted"
              title={capacityBlockedReason(capacity) ?? "Approved, waiting for a slot to free up"}
              aria-label="Approved, waiting for a slot to free up"
            />
          ) : isClosed ? (
            <ClosedTaskCardMenu taskId={task.id} taskTitle={task.title} />
          ) : null}
        </div>
      </div>

      <p className="mt-1 truncate text-[11px] text-muted">{task.repo.name}</p>

      {/* S1 §3.1 — one line: how long, and (for `running`) what next. */}
      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
        <span>{metaLine}</span>
        {slow ? <Badge tone="warning">slow</Badge> : null}
      </p>

      {/* S1 §3.3 — which of the three "Not delivered" outcomes, and why. */}
      {isClosed ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge tone="danger">{CLOSED_LABEL[task.currentStage] ?? task.currentStage.toLowerCase()}</Badge>
          {task.failureReason ? (
            <span className="truncate text-[11px] text-muted" title={task.failureReason}>
              {truncateReason(task.failureReason)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1">
        <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
        {task.difficulty ? <Badge tone="info">size {task.difficulty}</Badge> : null}
        {task.criticality ? (
          <Badge tone={task.criticality === "high" ? "danger" : "neutral"}>
            {task.criticality} risk
          </Badge>
        ) : null}
        {task.costUsd > 0 ? <Badge tone="neutral">{formatCost(task.costUsd)}</Badge> : null}
      </div>
    </div>
  );
}

/** How many cards a column shows before collapsing into "showing N of M — see all" (S9 §4.4). */
const COLUMN_CARD_LIMIT = 20;

/**
 * Kanban view of the pipeline: one column per stage, plus a dedicated
 * "On Queue" column spliced in right after "Created".
 *
 * Terminal states other than COMPLETED are collected into a trailing column so
 * the board does not grow a column per failure mode.
 *
 * `BOARD_STAGES` has fourteen entries (`VERIFICATION` joined it alongside
 * `DEVELOPMENT`); adding "On Queue" and "Not delivered" makes sixteen columns
 * total. They are laid out as a wrapping grid rather than a horizontally
 * scrolling row: at sixteen across even a wide monitor leaves each column too
 * narrow to read, so the columns wrap into whole rows instead. Sixteen
 * divides evenly into the grid's 2- and 4-per-row breakpoints (eight and four
 * full rows) but not its 3- or 6-per-row breakpoints — those layouts' last
 * row is simply short, which is a cosmetic gap, not a bug.
 */
export function TaskBoard({
  tasks,
  capacity,
  maxJobAttempts,
  now = currentTimeMs(),
}: {
  tasks: BoardTask[];
  capacity: CardMenuCapacity;
  /** For the `retry_backoff` card's "attempt N of {maxJobAttempts}" — `MAX_JOB_ATTEMPTS`. */
  maxJobAttempts: number;
  /**
   * A single clock read for the whole render, passed down from `page.tsx`
   * (the RSC render) so every card's age/elapsed math agrees and the server
   * and client render of this `"use client"` component never disagree on
   * "now" — see S1's meta line.
   */
  now?: number;
}) {
  const byStage = new Map<Stage, BoardTask[]>();
  const onQueue: BoardTask[] = [];
  const closed: BoardTask[] = [];

  for (const task of tasks) {
    if (["REJECTED", "FAILED", "CANCELLED"].includes(task.currentStage)) {
      closed.push(task);
      continue;
    }
    // A `CREATED` task parked by "Start selected" losing the capacity race
    // shows under "On Queue" instead of "Created" — its `currentStage` is
    // still `CREATED`, so the split has to happen on `status`, not stage.
    if (task.currentStage === "CREATED" && task.status === "on_queue") {
      onQueue.push(task);
      continue;
    }
    const bucket = byStage.get(task.currentStage) ?? [];
    bucket.push(task);
    byStage.set(task.currentStage, bucket);
  }

  // S7 §8.1/§8.2 — rendered in the real promotion order (`queuePosition`,
  // computed server-side by `page.tsx` from the shared ranking module over
  // *every* `on_queue` task, not just this filtered/visible subset), not
  // `listTasks`' `createdAt desc`. A task with no position (defensive; every
  // `on_queue` task should have one) sorts last rather than crashing the sort.
  onQueue.sort((a, b) => (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER));

  const columns: Array<{ key: string; label: string; items: BoardTask[]; overflowStatus?: string }> = [];
  for (const stage of BOARD_STAGES) {
    columns.push({
      key: stage,
      label: STAGE_LABELS[stage],
      items: byStage.get(stage) ?? [],
      // Approximate: several stages share one `TaskStatus` (e.g. every
      // agent stage is "running"), so this "see all" link is a superset of
      // the column, not an exact match — better than no escape hatch at all
      // for a column past `COLUMN_CARD_LIMIT` (S9 §4.4).
      overflowStatus: statusForStage(stage),
    });
    if (stage === "CREATED") {
      columns.push({ key: "ON_QUEUE", label: "On Queue", items: onQueue, overflowStatus: "on_queue" });
    }
  }
  columns.push({ key: "CLOSED", label: "Not delivered", items: closed });

  return (
    // `items-start` keeps each column as tall as its own cards. Stretching them
    // to match the tallest column in the row would leave large empty boxes,
    // which is the opposite of fitting the board on one screen.
    <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {columns.map((column) => (
        <section
          key={column.key}
          className="flex min-w-0 flex-col rounded-lg border border-border bg-surface"
        >
          <header className="flex items-baseline justify-between gap-1 border-b border-border px-2.5 py-2">
            <h2
              className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted"
              title={column.label}
            >
              {column.label}
            </h2>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">
              {column.items.length}
            </span>
          </header>

          {column.items.length === 0 ? (
            // An empty column collapses to the header plus a thin strip: with a
            // linear pipeline most columns are empty at any moment, and giving
            // each one a full-height placeholder is what pushes the board off
            // the screen.
            <div className="px-2.5 py-2 text-[11px] text-muted/50">—</div>
          ) : (
            <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto p-2">
              {column.items.slice(0, COLUMN_CARD_LIMIT).map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  capacity={capacity}
                  maxJobAttempts={maxJobAttempts}
                  now={now}
                />
              ))}
              {column.items.length > COLUMN_CARD_LIMIT ? (
                <Link
                  href={column.overflowStatus ? `/tasks?status=${column.overflowStatus}` : "/tasks"}
                  className="text-center text-[11px] text-accent underline-offset-2 hover:underline"
                >
                  showing {COLUMN_CARD_LIMIT} of {column.items.length} — see all
                </Link>
              ) : null}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
