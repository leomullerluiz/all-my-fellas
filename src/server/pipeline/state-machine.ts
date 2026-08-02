import {
  GATE_ALLOWED_DECISIONS,
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

/** Verdict emitted by a reviewing stage — `CODE_REVIEW` or `QA`. */
export type ReviewVerdict = "approved" | "changes_requested";

export type PipelineSignal =
  /** The task was just created and should enter the first stage. */
  | { kind: "start" }
  /**
   * An agent (or the delivery step) finished successfully.
   *
   * `reviewVerdict` is shared by `CODE_REVIEW` and `QA`: both produce the same
   * approve / request-changes shape, and two near-identical fields would invite
   * passing the wrong one.
   */
  | { kind: "stage_succeeded"; stage: Stage; reviewVerdict?: ReviewVerdict }
  /** An agent (or the delivery step) exhausted its retries. */
  | { kind: "stage_failed"; stage: Stage; error: string }
  /** A human recorded a decision on a gate. */
  | { kind: "gate_decided"; gate: Gate; decision: GateDecision; comment?: string }
  /** The user cancelled the task. */
  | { kind: "cancel" };

export type PipelineContext = {
  /** Number of DEVELOPMENT runs already performed (1 after the first pass). */
  developmentAttempts: number;
  /**
   * Maximum rework cycles allowed. Shared by every source that can send work
   * back to the Developer: `CODE_REVIEW`, `QA` and `HUMAN_CODE_REVIEW`.
   */
  reworkMaxCycles: number;
  /**
   * Whether the human plan gate applies. The Architect can waive it for
   * low-criticality work when `autoApproveLowCriticality` is enabled.
   */
  planGateRequired: boolean;
  /** Whether the task opted into a human code review before delivery. */
  humanCodeReviewRequired: boolean;
};

export type Transition =
  /** Move to `stage` and enqueue a run for it. */
  | { type: "run"; stage: Stage; attempt: number }
  /** Park the task on a gate and wait for a human. */
  | { type: "await_gate"; gate: Gate }
  /** Stop the pipeline. */
  | { type: "terminal"; stage: TerminalStage; reason?: string };

/**
 * Linear happy-path successor for each agent stage.
 *
 * `CODE_REVIEW` and `QA` branch on a verdict and the gates branch on a human
 * decision, so both are handled explicitly in {@link nextTransition}.
 */
const LINEAR_SUCCESSOR: Partial<Record<Stage, Stage>> = {
  STAKEHOLDER_REFINEMENT: "PO_REFINEMENT",
  PO_REFINEMENT: "ARCHITECTURE",
  DEVELOPMENT: "CODE_REVIEW",
  PO_HOMOLOGATION: "STAKEHOLDER_GATE",
  DELIVERY: "COMPLETED",
};

export class InvalidTransitionError extends Error {
  constructor(current: Stage, signal: PipelineSignal) {
    super(`No transition from ${current} for signal ${signal.kind}`);
    this.name = "InvalidTransitionError";
  }
}

/** A decision the gate does not accept, e.g. `request_changes` on the plan gate. */
export class InvalidGateDecisionError extends Error {
  constructor(
    readonly gate: Gate,
    readonly decision: GateDecision,
  ) {
    super(
      `${gate} does not accept "${decision}"; allowed: ` +
        GATE_ALLOWED_DECISIONS[gate].join(", "),
    );
    this.name = "InvalidGateDecisionError";
  }
}

/**
 * Sends work back to the Developer, or fails the task when the shared rework
 * budget is spent.
 *
 * `CODE_REVIEW`, `QA` and a human `request_changes` all land here, so the
 * budget is genuinely shared rather than one allowance per reviewer.
 */
function reworkOrFail(context: PipelineContext, reason: string): Transition {
  // A first DEVELOPMENT pass plus N rework cycles means N+1 attempts total.
  if (context.developmentAttempts > context.reworkMaxCycles) {
    return {
      type: "terminal",
      stage: "FAILED",
      reason:
        `${reason}, but the rework budget of ${context.reworkMaxCycles} cycle(s) is ` +
        `exhausted. Raise "rework cycles" in Settings to allow another attempt.`,
    };
  }
  return {
    type: "run",
    stage: "DEVELOPMENT",
    attempt: context.developmentAttempts + 1,
  };
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
    if (!GATE_ALLOWED_DECISIONS[signal.gate].includes(signal.decision)) {
      throw new InvalidGateDecisionError(signal.gate, signal.decision);
    }
    if (signal.decision === "reject") {
      return { type: "terminal", stage: "REJECTED", reason: signal.comment };
    }
    if (signal.decision === "request_changes") {
      return reworkOrFail(context, "The reviewer requested changes");
    }

    // Exhaustive over `Gate`. A ternary here previously meant "any gate that is
    // not PLAN_GATE goes to delivery", which would have sent an approved human
    // code review straight past homologation and the stakeholder gate.
    switch (signal.gate) {
      case "PLAN_GATE":
        return {
          type: "run",
          stage: "DEVELOPMENT",
          attempt: context.developmentAttempts + 1,
        };
      case "HUMAN_CODE_REVIEW":
        return { type: "run", stage: "PO_HOMOLOGATION", attempt: 1 };
      case "STAKEHOLDER_GATE":
        return { type: "run", stage: "DELIVERY", attempt: 1 };
      default: {
        const unreachable: never = signal.gate;
        throw new InvalidTransitionError(unreachable, signal);
      }
    }
  }

  // signal.kind === "stage_succeeded"
  if (signal.stage !== current) throw new InvalidTransitionError(current, signal);

  if (current === "ARCHITECTURE") {
    return context.planGateRequired
      ? { type: "await_gate", gate: "PLAN_GATE" }
      : { type: "run", stage: "DEVELOPMENT", attempt: context.developmentAttempts + 1 };
  }

  if (current === "CODE_REVIEW") {
    return signal.reviewVerdict === "approved"
      ? { type: "run", stage: "QA", attempt: 1 }
      : reworkOrFail(context, "Code review requested changes");
  }

  if (current === "QA") {
    if (signal.reviewVerdict !== "approved") {
      return reworkOrFail(context, "QA requested changes");
    }
    return context.humanCodeReviewRequired
      ? { type: "await_gate", gate: "HUMAN_CODE_REVIEW" }
      : { type: "run", stage: "PO_HOMOLOGATION", attempt: 1 };
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
