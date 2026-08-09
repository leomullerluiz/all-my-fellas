import { type AuthMode, type Cadence, type QuotaLimit, resolveProviderAuth } from "../config/env";
import type { LlmProviderId } from "../config/llm-providers";
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
 * How a configured quota limit is enforced at admission time (§2 / stories.md
 * S2). Neither `resolveQuotaStatus` nor `resolveEnforcementQuotaStatus` below
 * ever changes behaviour based on this — they stay pure read-outs;
 * `assertWithinQuota` (`orchestrator.ts`) is what actually branches on it.
 *
 * - `"off"` — today's behaviour: the bar renders, nothing is refused. Default,
 *   so an existing installation with no opinion behaves exactly as before.
 * - `"warn"` — the start proceeds; a `quota_warning` event is appended.
 * - `"hold"` — the start is refused (`QuotaError`) unless overridden.
 */
export type QuotaEnforcement = "off" | "warn" | "hold";

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
  if (cadence === "monthly") {
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
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
  if (cadence === "monthly") {
    // `setMonth(getMonth() + 1)` on the 1st, not "add 30 days" — correct
    // across 28/29/30/31-day months without special-casing any of them, the
    // same way the daily branch below advances by calendar day rather than a
    // fixed 86_400_000ms.
    date.setMonth(date.getMonth() + 1);
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
 * usage figure. Deliberately not scoped to one provider: it is the total bill
 * across everything that ran, the same figure it always was.
 */
export function spendToday(now: number = Date.now()): number {
  return costSince(periodStart("daily", now));
}

/**
 * Pool-wide status against the *Claude* auth mode's configured limit — the
 * shape and the computation `resolveQuotaStatus` had before stories.md S2
 * segmented quota by provider.
 *
 * Kept as its own function, used only by `orchestrator.ts`'s
 * `assertWithinQuota`, so that S2's display feature (an array, one entry per
 * *provider*) cannot silently change hold/warn enforcement math as a side
 * effect. Do not collapse this back into `resolveQuotaStatus` — see
 * `techplan.md`'s risk note on exactly this.
 */
export type EnforcementQuotaStatus =
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
 * Pool-wide (every provider) usage against the Claude auth mode's configured
 * limit. `"not_configured"` covers both "no Claude credential at all" and
 * "credential present but no limit typed in for that mode".
 */
export function resolveEnforcementQuotaStatus(now: number = Date.now()): EnforcementQuotaStatus {
  const auth = resolveProviderAuth();
  if (auth.mode === "missing") return { state: "not_configured", authMode: auth.mode };

  const quota = getSettings().quotaLimits[auth.mode];
  if (quota.limitUsd === null) return { state: "not_configured", authMode: auth.mode };

  const usedUsd = costSince(periodStart(quota.cadence, now));
  const ratio = quota.limitUsd > 0 ? usedUsd / quota.limitUsd : usedUsd > 0 ? Number.POSITIVE_INFINITY : 0;
  const state = ratio >= 1 ? "exceeded" : ratio >= getSettings().warningRatio ? "warning" : "normal";

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

/**
 * One provider's usage against its own configured limit — always
 * "configured" by construction, since `resolveQuotaStatus` only ever builds
 * one of these for a provider that has a limit set (§2/stories.md S2).
 */
export type QuotaStatus = {
  provider: LlmProviderId;
  /** Only meaningful for `provider: "claude"` — the other two have no auth-mode split. */
  authMode?: AuthMode;
  state: "normal" | "warning" | "exceeded";
  cadence: Cadence;
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number;
  resetAt: number;
};

function buildStatus(
  provider: LlmProviderId,
  authMode: AuthMode | undefined,
  quota: QuotaLimit,
  now: number,
): QuotaStatus {
  const limitUsd = quota.limitUsd ?? 0;
  const usedUsd = costSince(periodStart(quota.cadence, now), provider);
  const ratio = limitUsd > 0 ? usedUsd / limitUsd : usedUsd > 0 ? Number.POSITIVE_INFINITY : 0;
  const state = ratio >= 1 ? "exceeded" : ratio >= getSettings().warningRatio ? "warning" : "normal";

  return {
    provider,
    authMode,
    state,
    cadence: quota.cadence,
    limitUsd,
    usedUsd,
    // Never negative: S2 requires remaining to floor at 0 once exceeded.
    remainingUsd: Math.max(0, limitUsd - usedUsd),
    resetAt: nextReset(quota.cadence, now),
  };
}

/**
 * S2/S3: one status per provider that has a configured spend limit, for the
 * dashboard bar — replaces the single Claude-keyed result `resolveQuotaStatus`
 * used to return before quota was segmented by provider (§4.8's stated gap in
 * the brief).
 *
 * Claude contributes at most one entry, keyed by whichever auth mode is
 * currently active (there is only ever one), and only when that mode has a
 * limit configured — no credential means no active mode, so no entry. ChatGPT
 * and Gemini contribute an entry whenever a limit is configured for them,
 * regardless of whether their credential happens to be present: a spend
 * figure is worth planning around even before the key is added, and the AC
 * this exists for is exactly "no Claude credential plus a configured ChatGPT
 * limit still yields a usage bar" rather than `not_configured`.
 *
 * A provider with no limit configured is simply absent from the result —
 * never rendered as `0 / 0` or as `"not_configured"` alongside providers that
 * are, which is why this returns an array with no `"not_configured"` member
 * at all rather than reusing `EnforcementQuotaStatus`'s shape.
 */
export function resolveQuotaStatus(now: number = Date.now()): QuotaStatus[] {
  const settings = getSettings();
  const statuses: QuotaStatus[] = [];

  const claudeAuth = resolveProviderAuth();
  if (claudeAuth.mode !== "missing") {
    const quota = settings.quotaLimits[claudeAuth.mode];
    if (quota.limitUsd !== null) statuses.push(buildStatus("claude", claudeAuth.mode, quota, now));
  }

  for (const provider of ["chatgpt", "gemini"] as const) {
    const quota = settings.quotaLimits[provider];
    if (quota.limitUsd !== null) statuses.push(buildStatus(provider, undefined, quota, now));
  }

  return statuses;
}
