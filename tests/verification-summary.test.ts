import { describe, expect, it } from "vitest";

import type { VerificationRunRow } from "@/server/db/schema";
import {
  summarizeVerification,
  verificationBadgeLabel,
  verificationBadgeTone,
} from "@/server/pipeline/verification-summary";

/**
 * Pure formatting from `verification_runs` rows to the gate badge's four
 * states. `passed` must be the only state that renders with the success
 * tone — see spec-mechanical-verification.md §12.
 */

function row(overrides: Partial<VerificationRunRow> = {}): VerificationRunRow {
  return {
    id: "ver_1",
    taskId: "task_1",
    stageRunId: "run_1",
    kind: "build",
    command: "npm run build",
    exitCode: 0,
    timedOut: false,
    durationMs: 42_000,
    stdoutTail: "",
    stderrTail: "",
    createdAt: 0,
    ...overrides,
  };
}

describe("summarizeVerification", () => {
  it("is skipped for zero rows", () => {
    expect(summarizeVerification([])).toEqual({ status: "skipped" });
  });

  it("is passed when every row exited 0", () => {
    const rows = [row({ kind: "build", exitCode: 0 }), row({ kind: "test", exitCode: 0 })];
    expect(summarizeVerification(rows)).toEqual({
      status: "passed",
      results: [
        { kind: "build", durationMs: 42_000 },
        { kind: "test", durationMs: 42_000 },
      ],
    });
  });

  it("is failed with the failing command when a row exited non-zero", () => {
    const rows = [row({ kind: "build", exitCode: 0 }), row({ kind: "test", exitCode: 1 })];
    expect(summarizeVerification(rows)).toEqual({
      status: "failed",
      failedCommand: "npm run build",
      exitCode: 1,
    });
  });

  it("is errored — never failed — for a null exit code (timeout or spawn failure)", () => {
    const timedOut = [row({ kind: "install", exitCode: null, timedOut: true })];
    expect(summarizeVerification(timedOut)).toMatchObject({ status: "errored" });

    const unspawnable = [row({ kind: "install", exitCode: null, timedOut: false })];
    expect(summarizeVerification(unspawnable)).toMatchObject({ status: "errored" });
  });
});

describe("verificationBadgeTone", () => {
  it("is success only for passed", () => {
    expect(verificationBadgeTone({ status: "passed", results: [] })).toBe("success");
    expect(verificationBadgeTone({ status: "skipped" })).toBe("neutral");
    expect(verificationBadgeTone({ status: "errored", reason: "x" })).toBe("warning");
    expect(
      verificationBadgeTone({ status: "failed", failedCommand: "npm run build", exitCode: 1 }),
    ).toBe("danger");
  });
});

describe("verificationBadgeLabel", () => {
  it("names the not-configured case explicitly", () => {
    expect(verificationBadgeLabel({ status: "skipped" })).toBe(
      "Verification not configured for this repository",
    );
  });

  it("names the failing command and exit code", () => {
    expect(
      verificationBadgeLabel({ status: "failed", failedCommand: "npm run build", exitCode: 1 }),
    ).toContain("npm run build");
  });
});
