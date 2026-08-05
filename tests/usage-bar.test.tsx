// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UsageBar } from "@/components/usage-bar";
import type { QuotaStatus } from "@/server/usage/quota";

/**
 * S1's est./plain spend label and S2/S3's four visual states, driven purely
 * off props — no DB or router dependency, matching `tests/task-board.test.tsx`.
 */

afterEach(() => {
  cleanup();
});

const RESET_AT = new Date(2025, 5, 16, 0, 0, 0).getTime();

function configured(state: QuotaStatus["state"] & ("normal" | "warning" | "exceeded")): QuotaStatus {
  return {
    state,
    authMode: "api_key",
    cadence: "daily",
    limitUsd: 10,
    usedUsd: state === "exceeded" ? 10.5 : state === "warning" ? 8.5 : 7.9,
    remainingUsd: state === "exceeded" ? 0 : state === "warning" ? 1.5 : 2.1,
    resetAt: RESET_AT,
  };
}

describe("UsageBar spend label", () => {
  it("prefixes the spend figure with 'est.' in subscription mode", () => {
    render(
      <UsageBar
        spendToday={1.23}
        quota={{ state: "not_configured", authMode: "subscription" }}
      />,
    );
    expect(screen.getByText(/est\. spent today/i)).toBeTruthy();
    expect(screen.getByText("$1.23")).toBeTruthy();
  });

  it("labels the spend figure as plain spend in api_key mode", () => {
    render(<UsageBar spendToday={0} quota={{ state: "not_configured", authMode: "api_key" }} />);
    expect(screen.getByText(/^spent today$/i)).toBeTruthy();
    expect(screen.queryByText(/est\./i)).toBeNull();
    expect(screen.getByText("$0.00")).toBeTruthy();
  });
});

describe("UsageBar quota states", () => {
  it("shows a 'not configured' state instead of a usage figure", () => {
    render(
      <UsageBar spendToday={0} quota={{ state: "not_configured", authMode: "missing" }} />,
    );
    expect(screen.getByText(/quota not configured/i)).toBeTruthy();
    expect(screen.queryByText(/used of/)).toBeNull();
  });

  it("renders the normal state below 80% usage", () => {
    const { container } = render(<UsageBar spendToday={7.9} quota={configured("normal")} />);
    expect(container.querySelector('[data-state="normal"]')).toBeTruthy();
    expect(screen.getByText(/within quota/i)).toBeTruthy();
    expect(screen.getByText(/\$7\.90 used of \$10\.00/)).toBeTruthy();
  });

  it("renders a distinct warning state between 80% and 100% usage", () => {
    const { container } = render(<UsageBar spendToday={8.5} quota={configured("warning")} />);
    expect(container.querySelector('[data-state="warning"]')).toBeTruthy();
    expect(screen.getByText(/approaching quota/i)).toBeTruthy();
  });

  it("renders a distinct exceeded state at or above 100% usage, remaining floored at 0", () => {
    const { container } = render(<UsageBar spendToday={10.5} quota={configured("exceeded")} />);
    expect(container.querySelector('[data-state="exceeded"]')).toBeTruthy();
    expect(screen.getByText(/quota exceeded/i)).toBeTruthy();
    expect(screen.getByText(/\$0\.00 remaining/)).toBeTruthy();
  });

  it("uses a different data-state for each of the three configured states", () => {
    const states = ["normal", "warning", "exceeded"] as const;
    const rendered = states.map((state) => {
      const { container } = render(<UsageBar spendToday={0} quota={configured(state)} />);
      return container.querySelector("[data-state]")?.getAttribute("data-state");
    });
    expect(new Set(rendered).size).toBe(3);
  });

  it("shows the reset target when a limit is configured", () => {
    render(<UsageBar spendToday={7.9} quota={configured("normal")} />);
    expect(screen.getByText(/Resets/)).toBeTruthy();
  });
});
