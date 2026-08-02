import Link from "next/link";

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

function TaskCard({ task }: { task: BoardTask }) {
  const isRunning = task.status === "running";
  const needsAttention = task.status === "awaiting_gate";

  return (
    <Link
      href={`/tasks/${task.id}`}
      className="block rounded-md border border-border bg-surface-raised p-3 transition-colors hover:border-accent/60"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{task.title}</p>
        {isRunning ? (
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
    </Link>
  );
}

/**
 * Kanban view of the pipeline: one column per stage.
 *
 * Terminal states other than COMPLETED are collected into a trailing column so
 * the board does not grow a column per failure mode.
 */
export function TaskBoard({ tasks }: { tasks: BoardTask[] }) {
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
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
        {columns.map((column) => (
          <section
            key={column.key}
            className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-surface"
          >
            <header className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                {column.label}
              </h2>
              <span className="text-[11px] text-muted">{column.items.length}</span>
            </header>
            <div className="flex flex-col gap-2 p-2">
              {column.items.length === 0 ? (
                <p className="px-1 py-3 text-[11px] text-muted/70">Empty</p>
              ) : (
                column.items.map((task) => <TaskCard key={task.id} task={task} />)
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
