import { describe, expect, it } from "vitest";

import {
  GRANTS_REWORK_CYCLE,
  InvalidGateDecisionError,
  InvalidTransitionError,
  needsBranchHistory,
  type PipelineContext,
  RETRY_TARGET,
  nextTransition,
} from "@/server/pipeline/state-machine";
import { FAILURE_KINDS } from "@/server/pipeline/stages";

const base: PipelineContext = {
  developmentAttempts: 0,
  homologationAttempts: 0,
  reworkMaxCycles: 2,
  reworkBudgetGrant: 0,
  planGateRequired: true,
  humanCodeReviewRequired: false,
};

describe("nextTransition", () => {
  it("enters the pipeline at the stakeholder stage", () => {
    expect(nextTransition("CREATED", { kind: "start" }, base)).toEqual({
      type: "run",
      stage: "STAKEHOLDER_REFINEMENT",
      attempt: 1,
    });
  });

  it("refuses to start a task that already left CREATED", () => {
    expect(() => nextTransition("QA", { kind: "start" }, base)).toThrow(InvalidTransitionError);
  });

  it("walks the linear refinement stages", () => {
    expect(
      nextTransition(
        "STAKEHOLDER_REFINEMENT",
        { kind: "stage_succeeded", stage: "STAKEHOLDER_REFINEMENT" },
        base,
      ),
    ).toEqual({ type: "run", stage: "PO_REFINEMENT", attempt: 1 });

    expect(
      nextTransition("PO_REFINEMENT", { kind: "stage_succeeded", stage: "PO_REFINEMENT" }, base),
    ).toEqual({ type: "run", stage: "ARCHITECTURE", attempt: 1 });
  });

  it("parks on the plan gate after architecture", () => {
    expect(
      nextTransition("ARCHITECTURE", { kind: "stage_succeeded", stage: "ARCHITECTURE" }, base),
    ).toEqual({ type: "await_gate", gate: "PLAN_GATE" });
  });

  it("skips the plan gate when it has been waived", () => {
    expect(
      nextTransition(
        "ARCHITECTURE",
        { kind: "stage_succeeded", stage: "ARCHITECTURE" },
        { ...base, planGateRequired: false },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 1 });
  });

  it("sends development to verification, not straight to code review", () => {
    expect(
      nextTransition("DEVELOPMENT", { kind: "stage_succeeded", stage: "DEVELOPMENT" }, base),
    ).toEqual({ type: "run", stage: "VERIFICATION", attempt: 1 });
  });
});

describe("verification", () => {
  it("sends a passed (or skipped) verification to code review", () => {
    expect(
      nextTransition(
        "VERIFICATION",
        { kind: "stage_succeeded", stage: "VERIFICATION", reviewVerdict: "approved" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "CODE_REVIEW", attempt: 1 });
  });

  it("sends a failed verification back to development without touching code review", () => {
    expect(
      nextTransition(
        "VERIFICATION",
        { kind: "stage_succeeded", stage: "VERIFICATION", reviewVerdict: "changes_requested" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("treats a missing verdict as changes requested", () => {
    expect(
      nextTransition(
        "VERIFICATION",
        { kind: "stage_succeeded", stage: "VERIFICATION" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toMatchObject({ type: "run", stage: "DEVELOPMENT" });
  });

  it("names the failing command in the terminal reason once the budget is spent", () => {
    // `executeVerification` supplies `detail` with the failing command and
    // exit code (spec §9.1's worked example); the generic "Verification
    // failed" is only a fallback for a signal that omits it.
    const transition = nextTransition(
      "VERIFICATION",
      {
        kind: "stage_succeeded",
        stage: "VERIFICATION",
        reviewVerdict: "changes_requested",
        detail: "Verification failed (`npm run build` exited 1)",
      },
      { ...base, developmentAttempts: 3 },
    );
    expect(transition).toMatchObject({ type: "terminal", stage: "FAILED" });
    expect((transition as { reason: string }).reason).toContain(
      "Verification failed (`npm run build` exited 1)",
    );
  });
});

describe("code review", () => {
  it("sends an approved review to QA", () => {
    expect(
      nextTransition(
        "CODE_REVIEW",
        { kind: "stage_succeeded", stage: "CODE_REVIEW", reviewVerdict: "approved" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "QA", attempt: 1 });
  });

  it("sends a rejected review back to development", () => {
    expect(
      nextTransition(
        "CODE_REVIEW",
        { kind: "stage_succeeded", stage: "CODE_REVIEW", reviewVerdict: "changes_requested" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("treats a missing verdict as changes requested", () => {
    expect(
      nextTransition(
        "CODE_REVIEW",
        { kind: "stage_succeeded", stage: "CODE_REVIEW" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toMatchObject({ type: "run", stage: "DEVELOPMENT" });
  });
});

describe("QA", () => {
  it("goes to homologation when no human review was requested", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA", reviewVerdict: "approved" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "PO_HOMOLOGATION", attempt: 1 });
  });

  it("parks on the human code review gate when the task opted in", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA", reviewVerdict: "approved" },
        { ...base, developmentAttempts: 1, humanCodeReviewRequired: true },
      ),
    ).toEqual({ type: "await_gate", gate: "HUMAN_CODE_REVIEW" });
  });

  it("sends a rejection back to development", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA", reviewVerdict: "changes_requested" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("treats a missing verdict as changes requested", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toMatchObject({ type: "run", stage: "DEVELOPMENT" });
  });
});

describe("the shared rework budget", () => {
  // Every reviewer draws on the same allowance, so the outcome must not depend
  // on which one rejected.
  const rejections = [
    {
      name: "verification",
      signal: {
        kind: "stage_succeeded",
        stage: "VERIFICATION",
        reviewVerdict: "changes_requested",
      },
      from: "VERIFICATION",
    },
    {
      name: "code review",
      signal: {
        kind: "stage_succeeded",
        stage: "CODE_REVIEW",
        reviewVerdict: "changes_requested",
      },
      from: "CODE_REVIEW",
    },
    {
      name: "QA",
      signal: { kind: "stage_succeeded", stage: "QA", reviewVerdict: "changes_requested" },
      from: "QA",
    },
    {
      name: "a human reviewer",
      signal: {
        kind: "gate_decided",
        gate: "HUMAN_CODE_REVIEW",
        decision: "request_changes",
        comment: "fix it",
      },
      from: "HUMAN_CODE_REVIEW",
    },
  ] as const;

  for (const { name, signal, from } of rejections) {
    it(`allows exactly reworkMaxCycles reworks when ${name} rejects`, () => {
      expect(
        nextTransition(from, signal, { ...base, developmentAttempts: 2 }),
      ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 3 });
    });

    it(`fails once the budget is exhausted and ${name} rejects`, () => {
      const transition = nextTransition(from, signal, {
        ...base,
        developmentAttempts: 3,
      });
      expect(transition).toMatchObject({ type: "terminal", stage: "FAILED" });
      // The reason must name the cause; "failed" alone is baffling right after
      // a reviewer explicitly asked for changes.
      expect((transition as { reason: string }).reason).toContain("rework budget");
    });
  }
});

describe("the per-task rework budget grant (S2)", () => {
  it("terminates when the budget is exhausted and no grant is available", () => {
    const transition = nextTransition(
      "CODE_REVIEW",
      { kind: "stage_succeeded", stage: "CODE_REVIEW", reviewVerdict: "changes_requested" },
      { ...base, developmentAttempts: 3, reworkBudgetGrant: 0 },
    );
    expect(transition).toMatchObject({ type: "terminal", stage: "FAILED" });
  });

  it("spends a granted cycle instead of terminating", () => {
    const transition = nextTransition(
      "CODE_REVIEW",
      { kind: "stage_succeeded", stage: "CODE_REVIEW", reviewVerdict: "changes_requested" },
      { ...base, developmentAttempts: 3, reworkBudgetGrant: 1 },
    );
    expect(transition).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 4 });
  });

  it("terminates again once the granted cycle is also spent", () => {
    const transition = nextTransition(
      "CODE_REVIEW",
      { kind: "stage_succeeded", stage: "CODE_REVIEW", reviewVerdict: "changes_requested" },
      { ...base, developmentAttempts: 4, reworkBudgetGrant: 1 },
    );
    expect(transition).toMatchObject({ type: "terminal", stage: "FAILED" });
  });

  it("sets failedStage/failureKind to DEVELOPMENT/rework_exhausted on the terminal transition", () => {
    const transition = nextTransition(
      "QA",
      { kind: "stage_succeeded", stage: "QA", reviewVerdict: "changes_requested" },
      { ...base, developmentAttempts: 3 },
    );
    expect(transition).toMatchObject({
      type: "terminal",
      stage: "FAILED",
      failedStage: "DEVELOPMENT",
      failureKind: "rework_exhausted",
    });
  });

  it("names both numbers once a grant is in play, and only the configured number otherwise", () => {
    const noGrant = nextTransition(
      "QA",
      { kind: "stage_succeeded", stage: "QA", reviewVerdict: "changes_requested" },
      { ...base, developmentAttempts: 3, reworkBudgetGrant: 0 },
    );
    expect((noGrant as { reason: string }).reason).toContain("rework budget of 2 cycle(s)");
    expect((noGrant as { reason: string }).reason).not.toContain("granted by a retry");

    const granted = nextTransition(
      "QA",
      { kind: "stage_succeeded", stage: "QA", reviewVerdict: "changes_requested" },
      { ...base, developmentAttempts: 4, reworkBudgetGrant: 1 },
    );
    expect((granted as { reason: string }).reason).toContain(
      "rework budget of 3 cycle(s) (2 configured + 1 granted by a retry)",
    );
  });
});

describe("stage_failed carries the failed stage and kind (S1)", () => {
  it("defaults to stage_error when the signal omits a kind", () => {
    expect(
      nextTransition("ARCHITECTURE", { kind: "stage_failed", stage: "ARCHITECTURE", error: "boom" }, base),
    ).toMatchObject({
      type: "terminal",
      stage: "FAILED",
      failedStage: "ARCHITECTURE",
      failureKind: "stage_error",
    });
  });

  it("forwards an explicit kind", () => {
    expect(
      nextTransition(
        "DEVELOPMENT",
        { kind: "stage_failed", stage: "DEVELOPMENT", error: "no commits", failureKind: "no_commits" },
        base,
      ),
    ).toMatchObject({
      type: "terminal",
      stage: "FAILED",
      failedStage: "DEVELOPMENT",
      failureKind: "no_commits",
    });
  });
});

describe("RETRY_TARGET / GRANTS_REWORK_CYCLE totality", () => {
  it("has an entry for every FailureKind", () => {
    for (const kind of FAILURE_KINDS) {
      expect(RETRY_TARGET[kind]).toBeTypeOf("function");
      expect(GRANTS_REWORK_CYCLE[kind]).toBeTypeOf("boolean");
    }
  });

  it("re-runs the stage that threw for stage_error and artifact_invalid", () => {
    expect(RETRY_TARGET.stage_error("CODE_REVIEW")).toBe("CODE_REVIEW");
    expect(RETRY_TARGET.artifact_invalid("QA")).toBe("QA");
  });

  it("always names DEVELOPMENT for no_commits and rework_exhausted", () => {
    expect(RETRY_TARGET.no_commits("DEVELOPMENT")).toBe("DEVELOPMENT");
    expect(RETRY_TARGET.rework_exhausted("DEVELOPMENT")).toBe("DEVELOPMENT");
  });

  it("always names DELIVERY for delivery_failed", () => {
    expect(RETRY_TARGET.delivery_failed("DELIVERY")).toBe("DELIVERY");
  });

  it("only rework_exhausted grants an extra cycle", () => {
    expect(GRANTS_REWORK_CYCLE.rework_exhausted).toBe(true);
    for (const kind of FAILURE_KINDS) {
      if (kind !== "rework_exhausted") expect(GRANTS_REWORK_CYCLE[kind]).toBe(false);
    }
  });
});

describe("needsBranchHistory", () => {
  it("always needs history for rework_exhausted and delivery_failed", () => {
    expect(needsBranchHistory("DEVELOPMENT", "rework_exhausted", 4)).toBe(true);
    expect(needsBranchHistory("DELIVERY", "delivery_failed", 1)).toBe(true);
  });

  it("never needs history for no_commits, regardless of attempt", () => {
    expect(needsBranchHistory("DEVELOPMENT", "no_commits", 1)).toBe(false);
    expect(needsBranchHistory("DEVELOPMENT", "no_commits", 5)).toBe(false);
  });

  it("never needs history for the three pre-Development stages", () => {
    for (const stage of ["STAKEHOLDER_REFINEMENT", "PO_REFINEMENT", "ARCHITECTURE"] as const) {
      expect(needsBranchHistory(stage, "stage_error", 1)).toBe(false);
    }
  });

  it("does not need history for DEVELOPMENT's first attempt, but does past it", () => {
    expect(needsBranchHistory("DEVELOPMENT", "stage_error", 1)).toBe(false);
    expect(needsBranchHistory("DEVELOPMENT", "artifact_invalid", 2)).toBe(true);
  });

  it("needs history for CODE_REVIEW, QA, PO_HOMOLOGATION, DELIVERY and VERIFICATION", () => {
    for (const stage of ["CODE_REVIEW", "QA", "PO_HOMOLOGATION", "DELIVERY", "VERIFICATION"] as const) {
      expect(needsBranchHistory(stage, "stage_error", 1)).toBe(true);
    }
  });
});

describe("gates", () => {
  it("moves an approved plan into development", () => {
    expect(
      nextTransition(
        "PLAN_GATE",
        { kind: "gate_decided", gate: "PLAN_GATE", decision: "approve" },
        base,
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 1 });
  });

  it("sends an approved human code review to homologation, not to delivery", () => {
    // Regression: the previous ternary treated every non-PLAN_GATE approval as
    // "go to delivery", which would have skipped homologation and the
    // stakeholder gate entirely.
    expect(
      nextTransition(
        "HUMAN_CODE_REVIEW",
        { kind: "gate_decided", gate: "HUMAN_CODE_REVIEW", decision: "approve" },
        base,
      ),
    ).toEqual({ type: "run", stage: "PO_HOMOLOGATION", attempt: 1 });
  });

  it("still delivers after the stakeholder approves", () => {
    expect(
      nextTransition(
        "STAKEHOLDER_GATE",
        { kind: "gate_decided", gate: "STAKEHOLDER_GATE", decision: "approve" },
        base,
      ),
    ).toEqual({ type: "run", stage: "DELIVERY", attempt: 1 });
  });

  it("sends a human request_changes back to development", () => {
    expect(
      nextTransition(
        "HUMAN_CODE_REVIEW",
        {
          kind: "gate_decided",
          gate: "HUMAN_CODE_REVIEW",
          decision: "request_changes",
          comment: "extract the helper",
        },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("rejects the task when any gate is rejected", () => {
    for (const gate of ["PLAN_GATE", "HUMAN_CODE_REVIEW", "STAKEHOLDER_GATE"] as const) {
      expect(
        nextTransition(gate, { kind: "gate_decided", gate, decision: "reject", comment: "no" }, base),
      ).toEqual({ type: "terminal", stage: "REJECTED", reason: "no" });
    }
  });

  it("refuses request_changes on gates that do not review code", () => {
    for (const gate of ["PLAN_GATE"] as const) {
      expect(() =>
        nextTransition(
          gate,
          { kind: "gate_decided", gate, decision: "request_changes", comment: "x" },
          base,
        ),
      ).toThrow(InvalidGateDecisionError);
    }
  });

  it("sends a request_changes at the stakeholder gate back to development", () => {
    expect(
      nextTransition(
        "STAKEHOLDER_GATE",
        {
          kind: "gate_decided",
          gate: "STAKEHOLDER_GATE",
          decision: "request_changes",
          comment: "The stories asked for X, not Y",
        },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("fails a request_changes at the stakeholder gate once the budget is spent", () => {
    const transition = nextTransition(
      "STAKEHOLDER_GATE",
      {
        kind: "gate_decided",
        gate: "STAKEHOLDER_GATE",
        decision: "request_changes",
        comment: "Still not right",
      },
      { ...base, developmentAttempts: 3 },
    );
    expect(transition).toMatchObject({ type: "terminal", stage: "FAILED" });
    expect((transition as { reason: string }).reason).toContain("rework budget");
  });

  it("refuses a gate decision for a gate the task is not on", () => {
    expect(() =>
      nextTransition(
        "PLAN_GATE",
        { kind: "gate_decided", gate: "STAKEHOLDER_GATE", decision: "approve" },
        base,
      ),
    ).toThrow(InvalidTransitionError);
  });
});

describe("homologation", () => {
  it("parks an accepted verdict on the stakeholder gate", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION", homologationVerdict: "accepted" },
        { ...base, developmentAttempts: 1, homologationAttempts: 1 },
      ),
    ).toEqual({ type: "await_gate", gate: "STAKEHOLDER_GATE" });
  });

  it("sends a first rejection back to development, sharing the rework budget", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION", homologationVerdict: "rejected" },
        { ...base, developmentAttempts: 1, homologationAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("escalates a second rejection to the stakeholder gate instead of reworking again", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION", homologationVerdict: "rejected" },
        { ...base, developmentAttempts: 2, homologationAttempts: 2 },
      ),
    ).toEqual({ type: "await_gate", gate: "STAKEHOLDER_GATE" });
  });

  it("escalates a first rejection when the rework budget is already spent", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION", homologationVerdict: "rejected" },
        { ...base, developmentAttempts: 3, homologationAttempts: 1 },
      ),
    ).toEqual({ type: "await_gate", gate: "STAKEHOLDER_GATE" });
  });

  it("never fails the task outright, whatever the attempt count or budget", () => {
    const cases = [
      { developmentAttempts: 1, homologationAttempts: 1 },
      { developmentAttempts: 2, homologationAttempts: 2 },
      { developmentAttempts: 3, homologationAttempts: 1 },
      { developmentAttempts: 5, homologationAttempts: 3 },
    ];
    for (const context of cases) {
      const transition = nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION", homologationVerdict: "rejected" },
        { ...base, ...context },
      );
      expect(transition.type).not.toBe("terminal");
    }
  });

  it("fails closed: a missing verdict is treated as a rejection, not an acceptance", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION" },
        { ...base, developmentAttempts: 1, homologationAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("ignores a reviewVerdict on a PO_HOMOLOGATION signal and a homologationVerdict elsewhere", () => {
    // A `reviewVerdict` of "approved" must not count as homologation acceptance.
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        {
          kind: "stage_succeeded",
          stage: "PO_HOMOLOGATION",
          reviewVerdict: "approved",
        } as never,
        { ...base, developmentAttempts: 1, homologationAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });

    // A `homologationVerdict` on a QA signal must not be read as its verdict.
    expect(
      nextTransition(
        "QA",
        {
          kind: "stage_succeeded",
          stage: "QA",
          homologationVerdict: "accepted",
        } as never,
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });
});

describe("the tail of the pipeline", () => {
  it("completes after delivery", () => {
    expect(
      nextTransition("DELIVERY", { kind: "stage_succeeded", stage: "DELIVERY" }, base),
    ).toEqual({ type: "terminal", stage: "COMPLETED" });
  });

  it("fails from any stage on a stage failure, recording the cause (S1)", () => {
    expect(
      nextTransition(
        "DEVELOPMENT",
        { kind: "stage_failed", stage: "DEVELOPMENT", error: "boom" },
        base,
      ),
    ).toEqual({
      type: "terminal",
      stage: "FAILED",
      reason: "boom",
      failedStage: "DEVELOPMENT",
      failureKind: "stage_error",
    });
  });

  it("cancels from any stage", () => {
    expect(nextTransition("ARCHITECTURE", { kind: "cancel" }, base)).toEqual({
      type: "terminal",
      stage: "CANCELLED",
    });
  });

  it("rejects a success signal for a stage the task is not on", () => {
    expect(() =>
      nextTransition("QA", { kind: "stage_succeeded", stage: "DEVELOPMENT" }, base),
    ).toThrow(InvalidTransitionError);
  });
});
