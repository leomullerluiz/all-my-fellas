import { describe, expect, it } from "vitest";

import {
  InvalidGateDecisionError,
  InvalidTransitionError,
  type PipelineContext,
  nextTransition,
} from "@/server/pipeline/state-machine";

const base: PipelineContext = {
  developmentAttempts: 0,
  reworkMaxCycles: 2,
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

  it("sends development to code review, not straight to QA", () => {
    expect(
      nextTransition("DEVELOPMENT", { kind: "stage_succeeded", stage: "DEVELOPMENT" }, base),
    ).toEqual({ type: "run", stage: "CODE_REVIEW", attempt: 1 });
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
    for (const gate of ["PLAN_GATE", "STAKEHOLDER_GATE"] as const) {
      expect(() =>
        nextTransition(
          gate,
          { kind: "gate_decided", gate, decision: "request_changes", comment: "x" },
          base,
        ),
      ).toThrow(InvalidGateDecisionError);
    }
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

describe("the tail of the pipeline", () => {
  it("parks on the stakeholder gate after homologation", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION" },
        base,
      ),
    ).toEqual({ type: "await_gate", gate: "STAKEHOLDER_GATE" });
  });

  it("completes after delivery", () => {
    expect(
      nextTransition("DELIVERY", { kind: "stage_succeeded", stage: "DELIVERY" }, base),
    ).toEqual({ type: "terminal", stage: "COMPLETED" });
  });

  it("fails from any stage on a stage failure", () => {
    expect(
      nextTransition(
        "DEVELOPMENT",
        { kind: "stage_failed", stage: "DEVELOPMENT", error: "boom" },
        base,
      ),
    ).toEqual({ type: "terminal", stage: "FAILED", reason: "boom" });
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
