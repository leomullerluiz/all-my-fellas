import type { VerificationRunRow } from "../db/schema";

/**
 * Turns `verification_runs` rows into the four-state summary the gate badge
 * (and any other surface) renders. Pure and DB-free, so it is safe to import
 * from a client component — `page.tsx` does the query, this only formats it.
 *
 * `skipped` is not green — see spec-mechanical-verification.md §5.4. No
 * commands is the default state of every existing installation; rendering
 * that as a pass would recreate the exact defect this feature exists to fix.
 */
export type VerificationSummary =
  | { status: "skipped" }
  | { status: "passed"; results: Array<{ kind: string; durationMs: number }> }
  | { status: "failed"; failedCommand: string; exitCode: number | null }
  | { status: "errored"; reason: string };

export function summarizeVerification(rows: VerificationRunRow[]): VerificationSummary {
  if (rows.length === 0) return { status: "skipped" };

  // `exitCode === null` means the process was killed by the timeout or never
  // spawned at all — no verdict either way, so it is an environment problem,
  // never a code failure (§6.3).
  const noVerdict = rows.find((row) => row.exitCode === null);
  if (noVerdict) {
    return {
      status: "errored",
      reason: noVerdict.timedOut
        ? `\`${noVerdict.command}\` timed out`
        : `\`${noVerdict.command}\` could not be started`,
    };
  }

  const failed = rows.find((row) => row.exitCode !== 0);
  if (failed) {
    return { status: "failed", failedCommand: failed.command, exitCode: failed.exitCode };
  }

  return {
    status: "passed",
    results: rows.map((row) => ({ kind: row.kind, durationMs: row.durationMs })),
  };
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}

/** The badge label for each state, matching spec §12's table. */
export function verificationBadgeLabel(summary: VerificationSummary): string {
  switch (summary.status) {
    case "passed":
      return (
        "Verification passed" +
        (summary.results.length > 0
          ? ` · ${summary.results.map((r) => `${r.kind} ${formatDurationMs(r.durationMs)}`).join(" · ")}`
          : "")
      );
    case "skipped":
      return "Verification not configured for this repository";
    case "errored":
      return `Verification could not run: ${summary.reason}`;
    case "failed":
      return `Verification failed: \`${summary.failedCommand}\` exited ${summary.exitCode}`;
  }
}

/** The one state that renders with the success tone — see spec §12. */
export function verificationBadgeTone(
  summary: VerificationSummary,
): "success" | "neutral" | "warning" | "danger" {
  switch (summary.status) {
    case "passed":
      return "success";
    case "skipped":
      return "neutral";
    case "errored":
      return "warning";
    case "failed":
      return "danger";
  }
}
