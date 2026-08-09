// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UsageBar } from "@/components/usage-bar";
import type { QuotaStatus } from "@/server/usage/quota";

/**
 * S1's est./plain spend label and S2/S3's per-provider array with its four
 * visual states, driven purely off props — no DB or router dependency,
 * matching `tests/task-board.test.tsx`.
 */

afterEach(() => {
  cleanup();
});

const RESET_AT = new Date(2025, 5, 16, 0, 0, 0).getTime();

function configured(
  provider: QuotaStatus["provider"],
  state: QuotaStatus["state"],
): QuotaStatus {
  return {
    provider,
    authMode: provider === "claude" ? "api_key" : undefined,
    state,
    cadence: "daily",
    limitUsd: 10,
    usedUsd: state === "exceeded" ? 10.5 : state === "warning" ? 8.5 : 7.9,
    remainingUsd: state === "exceeded" ? 0 : state === "warning" ? 1.5 : 2.1,
    resetAt: RESET_AT,
  };
}

describe("UsageBar spend label", () => {
  it("prefixes the spend figure with 'est.' in subscription mode", () => {
    render(<UsageBar spendToday={1.23} authMode="subscription" quotas={[]} />);
    expect(screen.getByText(/est\. spent today/i)).toBeTruthy();
    expect(screen.getByText("$1.23")).toBeTruthy();
  });

  it("labels the spend figure as plain spend in api_key mode", () => {
    render(<UsageBar spendToday={0} authMode="api_key" quotas={[]} />);
    expect(screen.getByText(/^spent today$/i)).toBeTruthy();
    expect(screen.queryByText(/est\./i)).toBeNull();
    expect(screen.getByText("$0.00")).toBeTruthy();
  });
});

describe("UsageBar quota states", () => {
  it("shows a 'not configured' state instead of a usage figure when nothing is configured", () => {
    render(<UsageBar spendToday={0} authMode="missing" quotas={[]} />);
    expect(screen.getByText(/quota not configured/i)).toBeTruthy();
    expect(screen.queryByText(/used of/)).toBeNull();
  });

  it("renders the normal state below the warning threshold", () => {
    const { container } = render(
      <UsageBar spendToday={7.9} authMode="api_key" quotas={[configured("claude", "normal")]} />,
    );
    expect(container.querySelector('[data-state="normal"]')).toBeTruthy();
    expect(screen.getByText(/within quota/i)).toBeTruthy();
    expect(screen.getByText(/\$7\.90 used of \$10\.00/)).toBeTruthy();
  });

  it("renders a distinct warning state between the threshold and 100% usage", () => {
    const { container } = render(
      <UsageBar spendToday={8.5} authMode="api_key" quotas={[configured("claude", "warning")]} />,
    );
    expect(container.querySelector('[data-state="warning"]')).toBeTruthy();
    expect(screen.getByText(/approaching quota/i)).toBeTruthy();
  });

  it("renders a distinct exceeded state at or above 100% usage, remaining floored at 0", () => {
    const { container } = render(
      <UsageBar spendToday={10.5} authMode="api_key" quotas={[configured("claude", "exceeded")]} />,
    );
    expect(container.querySelector('[data-state="exceeded"]')).toBeTruthy();
    expect(screen.getByText(/quota exceeded/i)).toBeTruthy();
    expect(screen.getByText(/\$0\.00 remaining/)).toBeTruthy();
  });

  it("uses a different overall data-state for each of the three configured states", () => {
    const states = ["normal", "warning", "exceeded"] as const;
    const rendered = states.map((state) => {
      const { container } = render(
        <UsageBar spendToday={0} authMode="api_key" quotas={[configured("claude", state)]} />,
      );
      return container.querySelector("[data-state]")?.getAttribute("data-state");
    });
    expect(new Set(rendered).size).toBe(3);
  });

  it("shows the reset target when a limit is configured", () => {
    render(
      <UsageBar spendToday={7.9} authMode="api_key" quotas={[configured("claude", "normal")]} />,
    );
    expect(screen.getByText(/Resets/)).toBeTruthy();
  });

  it("renders one row per provider, and takes the worst state for the overall container", () => {
    const { container } = render(
      <UsageBar
        spendToday={5}
        authMode="missing"
        quotas={[configured("chatgpt", "normal"), configured("gemini", "exceeded")]}
      />,
    );
    expect(container.querySelector('[data-provider="chatgpt"]')).toBeTruthy();
    expect(container.querySelector('[data-provider="gemini"]')).toBeTruthy();
    expect(container.querySelector('[data-state="exceeded"]')).toBeTruthy();
  });
});
