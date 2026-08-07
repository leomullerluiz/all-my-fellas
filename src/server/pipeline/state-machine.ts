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

/**
 * Verdict emitted by `PO_HOMOLOGATION`. Deliberately not a `ReviewVerdict`: a
 * review rejection is a defect report, this one is a claim that the wrong
 * thing was built, and the pipeline routes them differently (rework once,
 * then escalate, never fail the task).
 */
export type HomologationVerdict = "accepted" | "rejected";

export type PipelineSignal =
  /** The task was just created and should enter the first stage. */
  | { kind: "start" }
  /**
   * An agent (or the delivery step) finished successfully.
   *
   * `reviewVerdict` is shared by `CODE_REVIEW` and `QA`: both produce the same
   * approve / request-changes shape, and two near-identical fields would invite
   * passing the wrong one. `homologationVerdict` is its own field rather than
   * folded into `reviewVerdict` — see the type's doc comment. `detail`, when
   * present, replaces the generic rework reason with one naming what actually
   * happened — `VERIFICATION` is the only caller with something more specific
   * than "requested changes" to say.
   */
  | {
      kind: "stage_succeeded";
      stage: Stage;
      reviewVerdict?: ReviewVerdict;
      homologationVerdict?: HomologationVerdict;
      detail?: string;
    }
  /** An agent (or the delivery step) exhausted its retries. */
  | { kind: "stage_failed"; stage: Stage; error: string }
  /** A human recorded a decision on a gate. */
  | { kind: "gate_decided"; gate: Gate; decision: GateDecision; comment?: string }
  /** The user cancelled the task. */
  | { kind: "cancel" };

export type PipelineContext = {
  /** Number of DEVELOPMENT runs already performed (1 after the first pass). */
  developmentAttempts: number;
  /** PO_HOMOLOGATION runs so far, including the one being handled. */
  homologationAttempts: number;
  /**
   * Maximum rework cycles allowed. Shared by every source that can send work
   * back to the Developer: `CODE_REVIEW`, `QA`, `HUMAN_CODE_REVIEW` and
   * `PO_HOMOLOGATION` (once, per §5.4 of the homologation-verdict spec).
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
 * `VERIFICATION`, `CODE_REVIEW`, `QA` and `PO_HOMOLOGATION` branch on a
 * verdict and the gates branch on a human decision, so all are handled
 * explicitly in {@link nextTransition}.
 */
const LINEAR_SUCCESSOR: Partial<Record<Stage, Stage>> = {
  STAKEHOLDER_REFINEMENT: "PO_REFINEMENT",
  PO_REFINEMENT: "ARCHITECTURE",
  DEVELOPMENT: "VERIFICATION",
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

// A first DEVELOPMENT pass plus N rework cycles means N+1 attempts total.
function reworkBudgetAvailable(context: PipelineContext): boolean {
  return context.developmentAttempts <= context.reworkMaxCycles;
}

/**
 * Sends work back to the Developer, or fails the task when the shared rework
 * budget is spent.
 *
 * `CODE_REVIEW`, `QA` and a human `request_changes` all land here, so the
 * budget is genuinely shared rather than one allowance per reviewer.
 * `PO_HOMOLOGATION` draws on the same budget predicate but never fails the
 * task — see the dedicated `PO_HOMOLOGATION` branch in {@link nextTransition}.
 */
function reworkOrFail(context: PipelineContext, reason: string): Transition {
  if (!reworkBudgetAvailable(context)) {
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

  if (current === "VERIFICATION") {
    // `skipped` is folded into `approved` at the call site (`executeVerification`)
    // — there is no third value here, matching `state-machine.ts`'s existing
    // rule against a second near-identical field.
    return signal.reviewVerdict === "approved"
      ? { type: "run", stage: "CODE_REVIEW", attempt: 1 }
      : reworkOrFail(context, signal.detail ?? "Verification failed");
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

  if (current === "PO_HOMOLOGATION") {
    if (signal.homologationVerdict === "accepted") {
      return { type: "await_gate", gate: "STAKEHOLDER_GATE" };
    }
    // Fail closed: a missing verdict (a caller that forgot to extract one) is
    // treated exactly like an explicit rejection, not like an acceptance.
    if (context.homologationAttempts <= 1 && reworkBudgetAvailable(context)) {
      return {
        type: "run",
        stage: "DEVELOPMENT",
        attempt: context.developmentAttempts + 1,
      };
    }
    // Second rejection, or no budget left. Escalate rather than fail: the
    // branch passed code review and QA, and only a human can decide whether
    // "not what we asked for" means ship it, rework it, or drop it.
    return { type: "await_gate", gate: "STAKEHOLDER_GATE" };
  }

  const successor = LINEAR_SUCCESSOR[current];
  if (!successor) throw new InvalidTransitionError(current, signal);

  if (successor === "COMPLETED") {
    return { type: "terminal", stage: "COMPLETED" };
  }
  // Defensive and currently unreachable: no `LINEAR_SUCCESSOR` value is a gate
  // since `PO_HOMOLOGATION` (the only stage that used to map to one) is now
  // handled explicitly above. Kept because the table's type still permits a
  // gate value, and the failure mode without this guard — `applyTransition`
  // scheduling a job for a gate stage — is worse than the dead branch.
  if (isGate(successor)) {
    return { type: "await_gate", gate: successor };
  }
  return { type: "run", stage: successor, attempt: 1 };
}
