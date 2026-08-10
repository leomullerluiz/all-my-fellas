import { describe, expect, it } from "vitest";

import { worstQuotaWarning } from "@/lib/quota-warning";
import type { QuotaStatus } from "@/server/usage/quota";

/**
 * `worstQuotaWarning`'s reduction — shared by `TaskCardMenu`'s dropdown
 * Start item and the dashboard's "Start selected" button, the two Start
 * affordances too small for the full `UsageBar` (stories.md S4).
 */

function status(overrides: Partial<QuotaStatus> = {}): QuotaStatus {
  return {
    provider: "claude",
    authMode: "subscription",
    state: "normal",
    cadence: "daily",
    limitUsd: 10,
    usedUsd: 1,
    remainingUsd: 9,
    resetAt: 0,
    ...overrides,
  };
}

describe("worstQuotaWarning", () => {
  it("returns null when there are no configured quotas", () => {
    expect(worstQuotaWarning([])).toBeNull();
  });

  it("returns null when every configured provider is within its limit", () => {
    expect(worstQuotaWarning([status({ state: "normal" })])).toBeNull();
  });

  it("returns a warning message when a provider is approaching its limit", () => {
    const result = worstQuotaWarning([status({ provider: "gemini", authMode: undefined, state: "warning" })]);
    expect(result).toEqual({ state: "warning", message: "Approaching Gemini (Google) quota." });
  });

  it("prefers exceeded over warning when both are present", () => {
    const result = worstQuotaWarning([
      status({ provider: "chatgpt", authMode: undefined, state: "warning" }),
      status({ provider: "gemini", authMode: undefined, state: "exceeded" }),
    ]);
    expect(result).toEqual({ state: "exceeded", message: "Gemini (Google) quota exceeded." });
  });
});
