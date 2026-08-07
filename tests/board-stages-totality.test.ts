import { describe, expect, it } from "vitest";

import { BOARD_STAGES, STAGES, TERMINAL_STAGES } from "@/server/pipeline/stages";

/**
 * `BOARD_STAGES` is a plain array, not a total `Record<Stage, …>`, so a stage
 * missing from it is not a compile error — it just vanishes from the
 * dashboard (spec-mechanical-verification.md §10.3). `STAGE_TONES` and
 * `STAGE_LABELS` get that protection from the compiler already; this is the
 * one totality check nothing else provides.
 */
describe("BOARD_STAGES", () => {
  it("has a column for every non-terminal stage, plus COMPLETED", () => {
    const nonTerminalOrCompleted = STAGES.filter(
      (stage) => stage === "COMPLETED" || !(TERMINAL_STAGES as readonly string[]).includes(stage),
    );
    for (const stage of nonTerminalOrCompleted) {
      expect(BOARD_STAGES).toContain(stage);
    }
    expect(BOARD_STAGES.length).toBe(nonTerminalOrCompleted.length);
  });

  it("excludes REJECTED, FAILED and CANCELLED (collected into 'Not delivered' instead)", () => {
    for (const stage of ["REJECTED", "FAILED", "CANCELLED"] as const) {
      expect(BOARD_STAGES).not.toContain(stage);
    }
  });

  it("includes VERIFICATION", () => {
    expect(BOARD_STAGES).toContain("VERIFICATION");
  });
});
