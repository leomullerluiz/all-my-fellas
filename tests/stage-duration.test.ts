import { describe, expect, it } from "vitest";

import { isSlow } from "@/server/pipeline/stage-duration";

/** S1 §3.2 — the "slow" marker's per-stage constant thresholds. */
describe("isSlow", () => {
  it("is false for a running DEVELOPMENT stage under its threshold", () => {
    const start = 1_000_000;
    expect(isSlow("DEVELOPMENT", start, start + 29 * 60_000)).toBe(false);
  });

  it("is true for a running DEVELOPMENT stage over its threshold", () => {
    const start = 1_000_000;
    expect(isSlow("DEVELOPMENT", start, start + 31 * 60_000)).toBe(true);
  });

  it("uses a shorter threshold for a lighter stage (STAKEHOLDER_REFINEMENT)", () => {
    const start = 1_000_000;
    expect(isSlow("STAKEHOLDER_REFINEMENT", start, start + 6 * 60_000)).toBe(true);
    expect(isSlow("STAKEHOLDER_REFINEMENT", start, start + 4 * 60_000)).toBe(false);
  });

  it("never reports a gate or terminal stage as slow (no threshold defined)", () => {
    const start = 1_000_000;
    const farFuture = start + 999 * 60_000;
    expect(isSlow("PLAN_GATE", start, farFuture)).toBe(false);
    expect(isSlow("COMPLETED", start, farFuture)).toBe(false);
  });
});
