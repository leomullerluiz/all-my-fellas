import {
  GATE_ALLOWED_DECISIONS,
  type FailureKind,
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
  /**
   * An agent (or the delivery step) exhausted its retries.
   *
   * `failureKind` defaults to `"stage_error"` (`nextTransition` applies the
   * default) — every caller but `execute.ts`'s three specific throw sites has
   * nothing more specific to say.
   */
  | { kind: "stage_failed"; stage: Stage; error: string; failureKind?: FailureKind }
  /** A human recorded a decision on a gate. */
  | { kind: "gate_decided"; gate: Gate; decision: GateDecision; comment?: string }
  /** The user cancelled the task. */
  | { kind: "cancel" };

export type PipelineContext = {
  /** Number of DEVELOPMENT runs already performed (1 after the first pass). */
  developmentAttempts: number;
  /**
   * Number of ARCHITECTURE runs already performed. Read by the `PLAN_GATE`
   * `request_changes` branch to number the rework run — deliberately not fed
   * into `reworkBudgetAvailable`, which only ever counts `DEVELOPMENT`
   * attempts. See `reworkOrFail`'s doc comment on why a human iterating on
   * the plan is not bounded by the same budget.
   */
  architectureAttempts: number;
  /** PO_HOMOLOGATION runs so far, including the one being handled. */
  homologationAttempts: number;
  /**
   * Maximum rework cycles allowed, from settings. Shared by every source that
   * can send work back to the Developer: `CODE_REVIEW`, `QA`,
   * `HUMAN_CODE_REVIEW` and `PO_HOMOLOGATION` (once, per §5.4 of the
   * homologation-verdict spec).
   */
  reworkMaxCycles: number;
  /**
   * Extra rework cycles this task has been granted by a retry, on top of
   * `reworkMaxCycles` — `tasks.rework_budget_grant`. The effective ceiling is
   * always `reworkMaxCycles + reworkBudgetGrant`.
   */
  reworkBudgetGrant: number;
  /**
   * Whether the human plan gate applies. The Architect can waive it for
   * low-criticality work when `autoApproveLowCriticality` is enabled.
   */
  planGateRequired: boolean;
  /** Whether the task opted into a human code review before delivery. */
  humanCodeReviewRequired: boolean;
  /**
   * Whether `CODE_REVIEW` is skipped for this task — settings.codeReviewEnabled
   * resolved against the task's own difficulty/criticality estimate. See
   * stories.md S6; the cheap alternative to a full named-profile system
   * (spec §7.2).
   */
  skipCodeReview: boolean;
};

export type Transition =
  /** Move to `stage` and enqueue a run for it. */
  | { type: "run"; stage: Stage; attempt: number }
  /** Park the task on a gate and wait for a human. */
  | { type: "await_gate"; gate: Gate }
  /**
   * Stop the pipeline. `failedStage`/`failureKind` are set only for `FAILED`
   * — a `cancel` or a gate `reject` carries neither, which is what lets
   * retry's "no cause recorded" refusal stay a genuine data gap rather than
   * firing on a deliberate human act (see `NotRetryableError` in
   * `orchestrator.ts`).
   */
  | {
      type: "terminal";
      stage: TerminalStage;
      reason?: string;
      failedStage?: Stage;
      failureKind?: FailureKind;
    };

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

/**
 * A first DEVELOPMENT pass plus N rework cycles means N+1 attempts total.
 * `reworkBudgetGrant` extends the ceiling per task — see {@link PipelineContext}.
 */
function reworkBudgetAvailable(context: PipelineContext): boolean {
  return context.developmentAttempts <= context.reworkMaxCycles + context.reworkBudgetGrant;
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
    const effectiveMax = context.reworkMaxCycles + context.reworkBudgetGrant;
    // Only mentioned once a retry has actually granted headroom, so a first
    // exhaustion still reads exactly as it always has.
    const grantNote =
      context.reworkBudgetGrant > 0
        ? ` (${context.reworkMaxCycles} configured + ${context.reworkBudgetGrant} granted by a retry)`
        : "";
    return {
      type: "terminal",
      stage: "FAILED",
      failedStage: "DEVELOPMENT",
      failureKind: "rework_exhausted",
      reason:
        `${reason}, but the rework budget of ${effectiveMax} cycle(s)${grantNote} is ` +
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
    return {
      type: "terminal",
      stage: "FAILED",
      reason: signal.error,
      failedStage: signal.stage,
      failureKind: signal.failureKind ?? "stage_error",
    };
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
      // `PLAN_GATE` reviews the Architect's plan, not the Developer's code, so
      // its `request_changes` re-runs `ARCHITECTURE` instead of going through
      // `reworkOrFail`. This deliberately does NOT draw on the shared rework
      // budget: every iteration here is a deliberate, manually initiated
      // human decision, not an agent loop — see `reworkBudgetAvailable`'s doc
      // comment. Routing this through `reworkOrFail` in a later refactor
      // would silently reintroduce a budget on human-driven plan review.
      if (signal.gate === "PLAN_GATE") {
        return {
          type: "run",
          stage: "ARCHITECTURE",
          attempt: context.architectureAttempts + 1,
        };
      }
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
    if (signal.reviewVerdict !== "approved") {
      return reworkOrFail(context, signal.detail ?? "Verification failed");
    }
    // `codeReviewEnabled: "auto"`/`"never"` on a trivial, low-risk task (or
    // unconditionally, for `"never"`) — see stories.md S6. `QA` and
    // `PO_HOMOLOGATION` run unaffected either way.
    return context.skipCodeReview
      ? { type: "run", stage: "QA", attempt: 1 }
      : { type: "run", stage: "CODE_REVIEW", attempt: 1 };
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

/**
 * Which stage a retry re-runs for each `FailureKind`, given the stage that
 * actually failed (`tasks.failed_stage`).
 *
 * Total over {@link FailureKind} so a new kind without an entry here fails the
 * build — see `stories.md` S1/S2. `stage_error` and `artifact_invalid` re-run
 * the stage that threw; the other three always name a fixed stage regardless
 * of where the failure was recorded (`reworkOrFail` and the delivery/no-commits
 * throw sites always set `failedStage` to that same stage anyway).
 */
export const RETRY_TARGET: Record<FailureKind, (failedStage: Stage) => Stage> = {
  stage_error: (failedStage) => failedStage,
  artifact_invalid: (failedStage) => failedStage,
  no_commits: () => "DEVELOPMENT",
  rework_exhausted: () => "DEVELOPMENT",
  delivery_failed: () => "DELIVERY",
};

/** Whether a retry of this `FailureKind` grants the task an extra rework cycle. */
export const GRANTS_REWORK_CYCLE: Record<FailureKind, boolean> = {
  stage_error: false,
  artifact_invalid: false,
  no_commits: false,
  rework_exhausted: true,
  delivery_failed: false,
};

const PRE_DEVELOPMENT_STAGES: readonly Stage[] = [
  "STAKEHOLDER_REFINEMENT",
  "PO_REFINEMENT",
  "ARCHITECTURE",
];

/**
 * Whether a retry of `failedStage`/`failureKind` needs the branch (and its
 * commit history) to still be on disk — i.e. whether it must be refused with
 * `workspace_gone` once the retention job has removed the workspace.
 *
 * `rework_exhausted` and `delivery_failed` always need it: the retried
 * Development run reads the reviewers' reports against the existing branch
 * (`gatherInputs`), and a delivery retry pushes commits that must already
 * exist. The three pre-Development stages never need it — nothing has cloned
 * yet. `no_commits` never needs it either: `hasCommitsAheadOfBase` can only
 * fire when the branch holds zero commits ahead of base, so there is nothing
 * to lose. Everything else — `CODE_REVIEW`, `QA`, `PO_HOMOLOGATION`,
 * `DELIVERY`, `VERIFICATION`, or `DEVELOPMENT` past its first attempt — needs
 * the history the earlier stages produced.
 *
 * @param failedRunAttempt The attempt number of the run that failed
 *   (`countStageRuns(taskId, failedStage)` at the moment of failure).
 */
export function needsBranchHistory(
  failedStage: Stage,
  failureKind: FailureKind,
  failedRunAttempt: number,
): boolean {
  if (failureKind === "rework_exhausted" || failureKind === "delivery_failed") return true;
  if (failureKind === "no_commits") return false;
  if (PRE_DEVELOPMENT_STAGES.includes(failedStage)) return false;
  if (failedStage === "DEVELOPMENT" && failedRunAttempt <= 1) return false;
  return true;
}
