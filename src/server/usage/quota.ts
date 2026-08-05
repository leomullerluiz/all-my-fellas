import { type AuthMode, type Cadence, resolveProviderAuth } from "../config/env";
import { getSettings } from "../settings/store";
import { costSince } from "../tasks/service";

/**
 * Usage-quota math for the dashboard's bottom bar (S1/S2/S3).
 *
 * There is no Anthropic API that reports the real Pro/Max or pay-per-use
 * quota, so everything here compares `stage_runs.cost_usd` against a limit
 * the user typed into Settings — see `spec-cost-forecast.md` §2 and this
 * feature's Out of Scope list. This module owns the cadence/threshold logic
 * so it can be unit tested without a browser or a running worker; `service.ts`
 * stays "SQL query only".
 */

export type { Cadence };

/**
 * Start of the current period, in **local server time**.
 *
 * S2's acceptance criteria pin "daily" to local midnight and "hourly" to the
 * local top of the hour, not UTC — do not "simplify" this to `Date.UTC`,
 * that would silently change what a user configured. `setHours`/`setMinutes`
 * operate on the local calendar, so they already follow the host's DST rules
 * correctly (a DST-transition day still has a well-defined local midnight and
 * a well-defined local top of every hour).
 */
export function periodStart(cadence: Cadence, now: number = Date.now()): number {
  const date = new Date(now);
  if (cadence === "hourly") {
    date.setMinutes(0, 0, 0);
    return date.getTime();
  }
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The next moment `periodStart` advances to — shown as the bar's reset target. */
export function nextReset(cadence: Cadence, now: number = Date.now()): number {
  const date = new Date(periodStart(cadence, now));
  if (cadence === "hourly") {
    date.setHours(date.getHours() + 1);
    return date.getTime();
  }
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

/**
 * S1: total cost across every task for stage runs that ran today.
 *
 * Always a calendar day regardless of the configured quota cadence — this is
 * the dashboard's "today's spend" figure, separate from S2's period-relative
 * usage figure.
 */
export function spendToday(now: number = Date.now()): number {
  return costSince(periodStart("daily", now));
}

/** How close usage is to the limit before the bar switches its visual state (S3). */
const WARNING_RATIO = 0.8;

export type QuotaStatus =
  | { state: "not_configured"; authMode: AuthMode }
  | {
      state: "normal" | "warning" | "exceeded";
      authMode: AuthMode;
      cadence: Cadence;
      limitUsd: number;
      usedUsd: number;
      remainingUsd: number;
      resetAt: number;
    };

/**
 * S2/S3: usage against the configured per-mode limit.
 *
 * `"not_configured"` covers both "no Claude credential at all" and "credential
 * present but no limit typed in for that mode" — S2 requires both to collapse
 * into the same state so the bar never computes a `0 / 0`.
 */
export function resolveQuotaStatus(now: number = Date.now()): QuotaStatus {
  const auth = resolveProviderAuth();
  if (auth.mode === "missing") return { state: "not_configured", authMode: auth.mode };

  const quota = getSettings().quotaLimits[auth.mode];
  if (quota.limitUsd === null) return { state: "not_configured", authMode: auth.mode };

  const usedUsd = costSince(periodStart(quota.cadence, now));
  const ratio = quota.limitUsd > 0 ? usedUsd / quota.limitUsd : usedUsd > 0 ? Number.POSITIVE_INFINITY : 0;
  const state = ratio >= 1 ? "exceeded" : ratio >= WARNING_RATIO ? "warning" : "normal";

  return {
    state,
    authMode: auth.mode,
    cadence: quota.cadence,
    limitUsd: quota.limitUsd,
    usedUsd,
    // Never negative: S2 requires remaining to floor at 0 once exceeded.
    remainingUsd: Math.max(0, quota.limitUsd - usedUsd),
    resetAt: nextReset(quota.cadence, now),
  };
}
