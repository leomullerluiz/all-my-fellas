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
  "VERIFICATION",
  "CODE_REVIEW",
  "QA",
  "HUMAN_CODE_REVIEW",
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
  "CODE_REVIEW",
  "QA",
  "PO_HOMOLOGATION",
] as const satisfies readonly Stage[];

export type AgentStage = (typeof AGENT_STAGES)[number];

export function isAgentStage(stage: Stage): stage is AgentStage {
  return (AGENT_STAGES as readonly Stage[]).includes(stage);
}

/** Stages that block on a human decision recorded through the UI. */
export const GATES = [
  "PLAN_GATE",
  "HUMAN_CODE_REVIEW",
  "STAKEHOLDER_GATE",
] as const satisfies readonly Stage[];

export type Gate = (typeof GATES)[number];

export function isGate(stage: Stage): stage is Gate {
  return (GATES as readonly Stage[]).includes(stage);
}

/**
 * Coarse task status shown on the board, derived from the current stage —
 * except `on_queue` and `gate_queued`, which are set explicitly by the
 * orchestrator rather than derived from `currentStage`:
 *
 * - `on_queue`: set by `startTasksBatch` on a `CREATED` task that lost the
 *   capacity race. `currentStage` stays `CREATED`.
 * - `gate_queued`: set by `decideGate` on a gated task whose approved
 *   decision resolves to `run` but no slot is free. `currentStage` stays the
 *   gate it was already on — the decision is recorded, but its effect is
 *   deferred until `promoteQueue` resumes it.
 *
 * `statusForStage` never produces either itself; only `orchestrator.ts`'s
 * batch/decision/promotion paths do.
 */
export const TASK_STATUSES = [
  "queued",
  "on_queue",
  "running",
  "awaiting_gate",
  "gate_queued",
  "completed",
  "rejected",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function statusForStage(stage: Stage): TaskStatus {
  // Gates are derived from `GATES` rather than listed again: enumerating them
  // here meant a newly added gate silently reported "running", which both lies
  // on the board and hides the task from the awaiting-approval count.
  if (isGate(stage)) return "awaiting_gate";

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
  /** Rendered by the worker from `verification_runs`, not by an agent. */
  "verification_report",
  "code_review_report",
  "qa_report",
  /** A human reviewer's requested changes, so they reach the Developer's prompt. */
  "human_review",
  "homolog_report",
  /**
   * The cheap part of the diff, persisted at `DELIVERY` before the workspace
   * is cleaned up — see spec-audit-trail.md §8. Not produced by an agent.
   */
  "diff_summary",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** File name each artifact type is written to inside the task workspace. */
export const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
  brief: "brief.md",
  stories: "stories.md",
  techplan: "techplan.md",
  dev_report: "dev-report.md",
  verification_report: "verification-report.md",
  code_review_report: "code-review-report.md",
  qa_report: "qa-report.md",
  human_review: "human-review.md",
  homolog_report: "homolog-report.md",
  diff_summary: "diff-summary.md",
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

/**
 * Why a task reached `FAILED`. Decides what a retry re-runs — see
 * `RETRY_TARGET` and `needsBranchHistory` in `state-machine.ts`.
 */
export const FAILURE_KINDS = [
  /** The agent session, the workspace, or a git command threw. */
  "stage_error",
  /** The produced document failed `validateArtifact`. */
  "artifact_invalid",
  /** DEVELOPMENT left nothing on the branch. */
  "no_commits",
  /** A reviewer rejected with the shared rework budget already spent. */
  "rework_exhausted",
  /** The push or the change-request call failed. */
  "delivery_failed",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * `request_changes` returns work to the Developer instead of ending the task.
 * It is only valid on gates that review code — see {@link GATE_ALLOWED_DECISIONS}.
 */
export const GATE_DECISIONS = ["approve", "request_changes", "reject"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/** Which decisions each gate accepts. Anything else is a 400, not a coercion. */
export const GATE_ALLOWED_DECISIONS: Record<Gate, readonly GateDecision[]> = {
  // `request_changes` here re-runs the Architect rather than the Developer —
  // see the `PLAN_GATE` case in `nextTransition`'s `request_changes` branch.
  // A plan that is "mostly right" no longer has to be approved or destroyed.
  PLAN_GATE: ["approve", "request_changes", "reject"],
  HUMAN_CODE_REVIEW: ["approve", "request_changes", "reject"],
  // `request_changes` here is a re-admission: a homologation-driven escalation
  // can land at this gate carrying a machine rejection, and a stakeholder must
  // be able to send it back to the Developer rather than only approve or
  // terminally reject verified work.
  STAKEHOLDER_GATE: ["approve", "request_changes", "reject"],
};

/** Short label used in the kanban column headers and timelines. */
export const STAGE_LABELS: Record<Stage, string> = {
  CREATED: "Created",
  STAKEHOLDER_REFINEMENT: "Stakeholder",
  PO_REFINEMENT: "Product Owner",
  ARCHITECTURE: "Architect",
  PLAN_GATE: "Plan gate",
  DEVELOPMENT: "Developer",
  VERIFICATION: "Verification",
  CODE_REVIEW: "Code review",
  QA: "QA",
  HUMAN_CODE_REVIEW: "Your review",
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
  "VERIFICATION",
  "CODE_REVIEW",
  "QA",
  "HUMAN_CODE_REVIEW",
  "PO_HOMOLOGATION",
  "STAKEHOLDER_GATE",
  "DELIVERY",
  "COMPLETED",
] as const satisfies readonly Stage[];
