import { describe, expect, it } from "vitest";

import {
  InvalidTransitionError,
  type PipelineContext,
  nextTransition,
} from "@/server/pipeline/state-machine";

const base: PipelineContext = {
  developmentAttempts: 0,
  qaMaxCycles: 2,
  planGateRequired: true,
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

  it("moves an approved plan into development", () => {
    expect(
      nextTransition(
        "PLAN_GATE",
        { kind: "gate_decided", gate: "PLAN_GATE", decision: "approve" },
        base,
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 1 });
  });

  it("rejects the task when a gate is rejected", () => {
    expect(
      nextTransition(
        "PLAN_GATE",
        { kind: "gate_decided", gate: "PLAN_GATE", decision: "reject", comment: "wrong module" },
        base,
      ),
    ).toEqual({ type: "terminal", stage: "REJECTED", reason: "wrong module" });
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

  it("sends approved QA to homologation", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA", qaVerdict: "approved" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "PO_HOMOLOGATION", attempt: 1 });
  });

  it("sends rejected QA back to development with the next attempt number", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA", qaVerdict: "changes_requested" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });

  it("treats a missing QA verdict as changes requested", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA" },
        { ...base, developmentAttempts: 1 },
      ),
    ).toMatchObject({ type: "run", stage: "DEVELOPMENT" });
  });

  it("fails the task once the QA rework budget is exhausted", () => {
    // qaMaxCycles = 2 allows the first pass plus two reworks: attempts 1..3.
    const transition = nextTransition(
      "QA",
      { kind: "stage_succeeded", stage: "QA", qaVerdict: "changes_requested" },
      { ...base, developmentAttempts: 3 },
    );
    expect(transition).toMatchObject({ type: "terminal", stage: "FAILED" });
  });

  it("allows exactly qaMaxCycles reworks before failing", () => {
    expect(
      nextTransition(
        "QA",
        { kind: "stage_succeeded", stage: "QA", qaVerdict: "changes_requested" },
        { ...base, developmentAttempts: 2 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 3 });
  });

  it("parks on the stakeholder gate after homologation", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION" },
        base,
      ),
    ).toEqual({ type: "await_gate", gate: "STAKEHOLDER_GATE" });
  });

  it("delivers after the stakeholder approves and completes afterwards", () => {
    expect(
      nextTransition(
        "STAKEHOLDER_GATE",
        { kind: "gate_decided", gate: "STAKEHOLDER_GATE", decision: "approve" },
        base,
      ),
    ).toEqual({ type: "run", stage: "DELIVERY", attempt: 1 });

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
