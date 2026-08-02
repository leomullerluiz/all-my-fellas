/**
 * The pipeline vocabulary: stages, task statuses, artifact types and gates.
 *
 * Everything downstream (database, worker, API, UI) derives its literal unions
 * from this module so a new stage cannot be half-added.
 */

/** Ordered list of every stage a task can occupy. */
export const STAGES = [
  "CREATED",
  "STAKEHOLDER_REFINEMENT",
  "PO_REFINEMENT",
  "ARCHITECTURE",
  "PLAN_GATE",
  "DEVELOPMENT",
  "QA",
  "PO_HOMOLOGATION",
  "STAKEHOLDER_GATE",
  "DELIVERY",
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;

export type Stage = (typeof STAGES)[number];

/** Stages that never transition anywhere else. */
export const TERMINAL_STAGES = [
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly Stage[];

export type TerminalStage = (typeof TERMINAL_STAGES)[number];

export function isTerminalStage(stage: Stage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly Stage[]).includes(stage);
}

/** Stages executed by an isolated Claude Agent SDK session. */
export const AGENT_STAGES = [
  "STAKEHOLDER_REFINEMENT",
  "PO_REFINEMENT",
  "ARCHITECTURE",
  "DEVELOPMENT",
  "QA",
  "PO_HOMOLOGATION",
] as const satisfies readonly Stage[];

export type AgentStage = (typeof AGENT_STAGES)[number];

export function isAgentStage(stage: Stage): stage is AgentStage {
  return (AGENT_STAGES as readonly Stage[]).includes(stage);
}

/** Stages that block on a human decision recorded through the UI. */
export const GATES = ["PLAN_GATE", "STAKEHOLDER_GATE"] as const satisfies readonly Stage[];

export type Gate = (typeof GATES)[number];

export function isGate(stage: Stage): stage is Gate {
  return (GATES as readonly Stage[]).includes(stage);
}

/** Coarse task status shown on the board, derived from the current stage. */
export const TASK_STATUSES = [
  "queued",
  "running",
  "awaiting_gate",
  "completed",
  "rejected",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function statusForStage(stage: Stage): TaskStatus {
  switch (stage) {
    case "CREATED":
      return "queued";
    case "COMPLETED":
      return "completed";
    case "REJECTED":
      return "rejected";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "PLAN_GATE":
    case "STAKEHOLDER_GATE":
      return "awaiting_gate";
    default:
      return "running";
  }
}

/** Markdown artifact kinds handed between stages. */
export const ARTIFACT_TYPES = [
  "brief",
  "stories",
  "techplan",
  "dev_report",
  "qa_report",
  "homolog_report",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** File name each artifact type is written to inside the task workspace. */
export const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
  brief: "brief.md",
  stories: "stories.md",
  techplan: "techplan.md",
  dev_report: "dev-report.md",
  qa_report: "qa-report.md",
  homolog_report: "homolog-report.md",
};

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DIFFICULTIES = ["S", "M", "L"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const CRITICALITIES = ["low", "medium", "high"] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const STAGE_RUN_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "rejected",
] as const;
export type StageRunStatus = (typeof STAGE_RUN_STATUSES)[number];

export const GATE_DECISIONS = ["approve", "reject"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/** Short label used in the kanban column headers and timelines. */
export const STAGE_LABELS: Record<Stage, string> = {
  CREATED: "Created",
  STAKEHOLDER_REFINEMENT: "Stakeholder",
  PO_REFINEMENT: "Product Owner",
  ARCHITECTURE: "Architect",
  PLAN_GATE: "Plan gate",
  DEVELOPMENT: "Developer",
  QA: "QA",
  PO_HOMOLOGATION: "PO homologation",
  STAKEHOLDER_GATE: "Stakeholder gate",
  DELIVERY: "Delivery",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

/** Columns rendered on the dashboard, in pipeline order. */
export const BOARD_STAGES = [
  "CREATED",
  "STAKEHOLDER_REFINEMENT",
  "PO_REFINEMENT",
  "ARCHITECTURE",
  "PLAN_GATE",
  "DEVELOPMENT",
  "QA",
  "PO_HOMOLOGATION",
  "STAKEHOLDER_GATE",
  "DELIVERY",
  "COMPLETED",
] as const satisfies readonly Stage[];
