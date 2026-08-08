// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatePanel } from "@/components/task-actions";
import type { VerificationSummary } from "@/server/pipeline/verification-summary";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const GITHUB_PROVIDER = { displayName: "GitHub", changeRequestNoun: "pull request" };

/**
 * The four verification states on the `HUMAN_CODE_REVIEW` gate panel.
 * `passed` must be the only one rendered with the success tone — the other
 * three share "not green" (spec §5.4, §12).
 */
const CASES: Array<{ name: string; summary: VerificationSummary; label: RegExp; toneClass: string }> = [
  {
    name: "passed",
    summary: { status: "passed", results: [{ kind: "build", durationMs: 42_000 }] },
    label: /Verification passed/,
    toneClass: "text-success",
  },
  {
    name: "skipped",
    summary: { status: "skipped" },
    label: /Verification not configured/,
    toneClass: "text-muted",
  },
  {
    name: "errored",
    summary: { status: "errored", reason: "`npm ci` timed out" },
    label: /Verification could not run/,
    toneClass: "text-warning",
  },
  {
    name: "failed",
    summary: { status: "failed", failedCommand: "npm run build", exitCode: 1 },
    label: /Verification failed/,
    toneClass: "text-danger",
  },
];

describe("GatePanel verification badge", () => {
  for (const { name, summary, label } of CASES) {
    it(`renders the ${name} state`, () => {
      render(<GatePanel taskId="task_1" gate="HUMAN_CODE_REVIEW" provider={GITHUB_PROVIDER} verification={summary} />);
      expect(screen.getByText(label)).toBeTruthy();
    });
  }

  it("renders nothing when verification is not supplied (e.g. PLAN_GATE)", () => {
    render(<GatePanel taskId="task_1" gate="PLAN_GATE" provider={GITHUB_PROVIDER} verification={null} />);
    expect(screen.queryByText(/Verification/)).toBeNull();
  });

  it("only the passed state uses the success tone", () => {
    for (const { name, summary, toneClass } of CASES) {
      cleanup();
      render(<GatePanel taskId="task_1" gate="HUMAN_CODE_REVIEW" provider={GITHUB_PROVIDER} verification={summary} />);
      const badge = screen.getByText(/^Verification/);
      if (name === "passed") {
        expect(badge.className).toContain(toneClass);
      } else {
        expect(badge.className).not.toContain("text-success");
      }
    }
  });
});
