"use client";

import Link from "next/link";

import { TaskSelectCheckbox } from "@/components/batch-start";
import { TaskCardMenu, type CardMenuCapacity } from "@/components/task-card-menu";
import { Badge } from "@/components/ui/badge";
import { formatCost } from "@/lib/utils";
import { BOARD_STAGES, STAGE_LABELS, type Stage } from "@/server/pipeline/stages";
import type { TaskWithRepo } from "@/server/tasks/service";

/** One card on the board. */
export type BoardTask = TaskWithRepo & { costUsd: number };

const PRIORITY_TONE = {
  low: "neutral",
  medium: "neutral",
  high: "warning",
  urgent: "danger",
} as const;

/**
 * One card.
 *
 * The card is not a link. Only the title navigates, so the action menu can be a
 * sibling of the anchor rather than a `<button>` nested inside one — see
 * `spec-task-queue.md` §5.1. The generous padding on the title link keeps the
 * hit area the full height of the header row rather than just the glyphs.
 */
function TaskCard({ task, capacity }: { task: BoardTask; capacity: CardMenuCapacity }) {
  const isRunning = task.status === "running";
  const needsAttention = task.status === "awaiting_gate";
  const notStarted = task.currentStage === "CREATED";

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

        {notStarted ? (
          <div className="flex shrink-0 items-start gap-1">
            <TaskSelectCheckbox taskId={task.id} taskTitle={task.title} />
            <TaskCardMenu taskId={task.id} taskTitle={task.title} capacity={capacity} />
          </div>
        ) : isRunning ? (
          <span
            className="mt-1 inline-block size-2 shrink-0 rounded-full bg-accent animate-pipeline-pulse"
            title="An agent is running"
            aria-label="An agent is running"
          />
        ) : needsAttention ? (
          <span
            className="mt-1 inline-block size-2 shrink-0 rounded-full bg-warning"
            title="Waiting for your approval"
            aria-label="Waiting for your approval"
          />
        ) : null}
      </div>

      <p className="mt-1 truncate text-[11px] text-muted">{task.repo.name}</p>

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

/**
 * Kanban view of the pipeline: one column per stage.
 *
 * Terminal states other than COMPLETED are collected into a trailing column so
 * the board does not grow a column per failure mode.
 *
 * The twelve columns are laid out as a wrapping grid rather than a horizontally
 * scrolling row: at twelve across even a wide monitor leaves each column too
 * narrow to read, so the columns wrap into whole rows instead. The counts are
 * chosen to divide twelve evenly (2 / 3 / 4 / 6), which keeps every row full
 * and preserves the left-to-right, top-to-bottom pipeline order.
 */
export function TaskBoard({
  tasks,
  capacity,
}: {
  tasks: BoardTask[];
  capacity: CardMenuCapacity;
}) {
  const byStage = new Map<Stage, BoardTask[]>();
  const closed: BoardTask[] = [];

  for (const task of tasks) {
    if (["REJECTED", "FAILED", "CANCELLED"].includes(task.currentStage)) {
      closed.push(task);
      continue;
    }
    const bucket = byStage.get(task.currentStage) ?? [];
    bucket.push(task);
    byStage.set(task.currentStage, bucket);
  }

  const columns: Array<{ key: string; label: string; items: BoardTask[] }> = [
    ...BOARD_STAGES.map((stage) => ({
      key: stage,
      label: STAGE_LABELS[stage],
      items: byStage.get(stage) ?? [],
    })),
    { key: "CLOSED", label: "Not delivered", items: closed },
  ];

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
            <div className="flex flex-col gap-2 p-2">
              {column.items.map((task) => (
                <TaskCard key={task.id} task={task} capacity={capacity} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
