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
  QA: "accent",
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
  running: "accent",
  awaiting_gate: "warning",
  completed: "success",
  rejected: "danger",
  failed: "danger",
  cancelled: "neutral",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  // "Queued" would imply the system picks the task up on its own. Nothing
  // starts a task but the user — see `spec-task-queue.md` §3.
  queued: "Not started",
  running: "Running",
  awaiting_gate: "Awaiting approval",
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
