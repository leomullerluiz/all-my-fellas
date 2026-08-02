import {
  type Gate,
  type GateDecision,
  type Stage,
  type TerminalStage,
  isGate,
} from "./stages";

/**
 * Pure transition logic for the delivery pipeline.
 *
 * The worker is the only component allowed to apply a transition; the API
 * merely records gate decisions and cancellations. Keeping the rules pure and
 * side-effect free makes the whole pipeline unit testable.
 */

/** Verdict emitted by the QA stage, parsed out of `qa-report.md`. */
export type QaVerdict = "approved" | "changes_requested";

export type PipelineSignal =
  /** The task was just created and should enter the first stage. */
  | { kind: "start" }
  /** An agent (or the delivery step) finished successfully. */
  | { kind: "stage_succeeded"; stage: Stage; qaVerdict?: QaVerdict }
  /** An agent (or the delivery step) exhausted its retries. */
  | { kind: "stage_failed"; stage: Stage; error: string }
  /** A human recorded a decision on a gate. */
  | { kind: "gate_decided"; gate: Gate; decision: GateDecision; comment?: string }
  /** The user cancelled the task. */
  | { kind: "cancel" };

export type PipelineContext = {
  /** Number of DEVELOPMENT runs already performed (1 after the first pass). */
  developmentAttempts: number;
  /** Maximum QA -> Development rework cycles allowed. */
  qaMaxCycles: number;
  /**
   * Whether the human plan gate applies. The Architect can waive it for
   * low-criticality work when `autoApproveLowCriticality` is enabled.
   */
  planGateRequired: boolean;
};

export type Transition =
  /** Move to `stage` and enqueue a run for it. */
  | { type: "run"; stage: Stage; attempt: number }
  /** Park the task on a gate and wait for a human. */
  | { type: "await_gate"; gate: Gate }
  /** Stop the pipeline. */
  | { type: "terminal"; stage: TerminalStage; reason?: string };

/**
 * Linear happy-path successor for each agent stage. QA and the gates branch and
 * are therefore handled explicitly in {@link nextTransition}.
 */
const LINEAR_SUCCESSOR: Partial<Record<Stage, Stage>> = {
  STAKEHOLDER_REFINEMENT: "PO_REFINEMENT",
  PO_REFINEMENT: "ARCHITECTURE",
  DEVELOPMENT: "QA",
  PO_HOMOLOGATION: "STAKEHOLDER_GATE",
  DELIVERY: "COMPLETED",
};

export class InvalidTransitionError extends Error {
  constructor(current: Stage, signal: PipelineSignal) {
    super(`No transition from ${current} for signal ${signal.kind}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Computes the next transition for a task.
 *
 * @throws {InvalidTransitionError} when the signal cannot apply to `current`.
 */
export function nextTransition(
  current: Stage,
  signal: PipelineSignal,
  context: PipelineContext,
): Transition {
  if (signal.kind === "cancel") {
    return { type: "terminal", stage: "CANCELLED" };
  }

  if (signal.kind === "stage_failed") {
    return { type: "terminal", stage: "FAILED", reason: signal.error };
  }

  if (signal.kind === "start") {
    if (current !== "CREATED") throw new InvalidTransitionError(current, signal);
    return { type: "run", stage: "STAKEHOLDER_REFINEMENT", attempt: 1 };
  }

  if (signal.kind === "gate_decided") {
    if (!isGate(current) || current !== signal.gate) {
      throw new InvalidTransitionError(current, signal);
    }
    if (signal.decision === "reject") {
      return { type: "terminal", stage: "REJECTED", reason: signal.comment };
    }
    return signal.gate === "PLAN_GATE"
      ? { type: "run", stage: "DEVELOPMENT", attempt: context.developmentAttempts + 1 }
      : { type: "run", stage: "DELIVERY", attempt: 1 };
  }

  // signal.kind === "stage_succeeded"
  if (signal.stage !== current) throw new InvalidTransitionError(current, signal);

  if (current === "ARCHITECTURE") {
    return context.planGateRequired
      ? { type: "await_gate", gate: "PLAN_GATE" }
      : { type: "run", stage: "DEVELOPMENT", attempt: context.developmentAttempts + 1 };
  }

  if (current === "QA") {
    if (signal.qaVerdict === "approved") {
      return { type: "run", stage: "PO_HOMOLOGATION", attempt: 1 };
    }
    // A first DEVELOPMENT pass plus N rework cycles means N+1 attempts total.
    if (context.developmentAttempts > context.qaMaxCycles) {
      return {
        type: "terminal",
        stage: "FAILED",
        reason: `QA rejected the change after ${context.qaMaxCycles} rework cycle(s).`,
      };
    }
    return {
      type: "run",
      stage: "DEVELOPMENT",
      attempt: context.developmentAttempts + 1,
    };
  }

  const successor = LINEAR_SUCCESSOR[current];
  if (!successor) throw new InvalidTransitionError(current, signal);

  if (successor === "COMPLETED") {
    return { type: "terminal", stage: "COMPLETED" };
  }
  if (isGate(successor)) {
    return { type: "await_gate", gate: successor };
  }
  return { type: "run", stage: successor, attempt: 1 };
}
