import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  STAGE_LABELS,
  type Stage,
  type StageRunStatus,
  type TaskStatus,
} from "@/server/pipeline/stages";

/** Shared stage/status colour mapping so the board and detail views agree. */

const STAGE_TONES: Record<Stage, NonNullable<BadgeProps["tone"]>> = {
  CREATED: "neutral",
  STAKEHOLDER_REFINEMENT: "info",
  PO_REFINEMENT: "info",
  ARCHITECTURE: "info",
  PLAN_GATE: "warning",
  DEVELOPMENT: "accent",
  CODE_REVIEW: "accent",
  QA: "accent",
  HUMAN_CODE_REVIEW: "warning",
  PO_HOMOLOGATION: "info",
  STAKEHOLDER_GATE: "warning",
  DELIVERY: "accent",
  COMPLETED: "success",
  REJECTED: "danger",
  FAILED: "danger",
  CANCELLED: "neutral",
};

export function StageBadge({ stage }: { stage: Stage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>;
}

const STATUS_TONES: Record<TaskStatus, NonNullable<BadgeProps["tone"]>> = {
  queued: "neutral",
  on_queue: "neutral",
  running: "accent",
  awaiting_gate: "warning",
  gate_queued: "neutral",
  completed: "success",
  rejected: "danger",
  failed: "danger",
  cancelled: "neutral",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  // "Queued" would imply the system picks the task up on its own, which used
  // to be true of every `CREATED` task — see `spec-task-queue.md` §3. That is
  // no longer the only "not auto-started" status: `on_queue` below *is*
  // picked up automatically once a slot frees, via "Start selected"'s queue.
  queued: "Not started",
  on_queue: "On queue",
  running: "Running",
  awaiting_gate: "Awaiting approval",
  // Distinct from both `awaiting_gate` (the decision has already been made)
  // and `running` (execution has not resumed yet) — the approval queue's
  // equivalent of `on_queue`, but for a gate resume instead of a start.
  gate_queued: "Approved · waiting for a slot",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

const RUN_TONES: Record<StageRunStatus, NonNullable<BadgeProps["tone"]>> = {
  pending: "neutral",
  running: "accent",
  done: "success",
  failed: "danger",
  rejected: "danger",
};

export function RunStatusBadge({ status }: { status: StageRunStatus }) {
  return <Badge tone={RUN_TONES[status]}>{status}</Badge>;
}
