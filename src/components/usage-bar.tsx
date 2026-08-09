import { Badge, type BadgeProps } from "@/components/ui/badge";
import { formatCost, formatDateTime } from "@/lib/utils";
import type { AuthMode, Cadence } from "@/server/config/env";
import { LLM_PROVIDER_LABELS } from "@/server/config/llm-providers";
import type { QuotaStatus } from "@/server/usage/quota";

/**
 * Bottom-of-dashboard bar (and, per stories.md S4, wherever spend is about to
 * be committed): today's spend (S1) plus, per provider that has a configured
 * limit, how much of it is used and when it resets (S2), rendered in a
 * visually distinct state as usage approaches or exceeds that provider's
 * limit (S3).
 *
 * Pure/presentational — the caller supplies both numbers already computed by
 * `spendToday()`/`resolveQuotaStatus()`, so this component needs no data
 * access of its own and follows the same refresh cadence as the rest of the
 * server-rendered page (no client-side polling is introduced here).
 */

const CONTAINER_TONE: Record<QuotaStatus["state"] | "empty", string> = {
  empty: "border-border bg-surface",
  normal: "border-border bg-surface",
  warning: "border-warning/40 bg-warning/10",
  exceeded: "border-danger/40 bg-danger/10",
};

const STATE_BADGE: Record<QuotaStatus["state"], { label: string; tone: BadgeProps["tone"] }> = {
  normal: { label: "Within quota", tone: "success" },
  warning: { label: "Approaching quota", tone: "warning" },
  exceeded: { label: "Quota exceeded", tone: "danger" },
};

const CADENCE_LABEL: Record<Cadence, string> = {
  daily: "daily",
  hourly: "hourly",
  monthly: "monthly",
};

const AUTH_MODE_SUFFIX: Record<AuthMode, string> = {
  subscription: " (subscription)",
  api_key: " (API key)",
  missing: "",
};

function providerLabel(quota: QuotaStatus): string {
  const suffix = quota.provider === "claude" && quota.authMode ? AUTH_MODE_SUFFIX[quota.authMode] : "";
  return `${LLM_PROVIDER_LABELS[quota.provider]}${suffix}`;
}

export function UsageBar({
  spendToday,
  authMode,
  quotas,
}: {
  spendToday: number;
  /** Claude's current credential mode — drives the "est." caveat below. */
  authMode: AuthMode;
  quotas: QuotaStatus[];
}) {
  // Subscription usage comes out of a Pro/Max allowance, not a bill — the
  // figure must never read as money actually spent. See `spec-cost-forecast.md` §2.
  const spendLabel = authMode === "subscription" ? "est. spent today" : "spent today";
  // Rendered state reflects the worst of every configured provider's status,
  // so the container's colour never understates how close *any* of them is.
  const overallState = quotas.some((quota) => quota.state === "exceeded")
    ? "exceeded"
    : quotas.some((quota) => quota.state === "warning")
      ? "warning"
      : quotas.length > 0
        ? "normal"
        : "empty";

  return (
    <div
      data-state={overallState}
      className={`mt-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 rounded-lg border px-4 py-3 text-xs ${CONTAINER_TONE[overallState]}`}
    >
      <div>
        <span className="text-muted">{spendLabel}</span>{" "}
        <span className="font-medium">{formatCost(spendToday)}</span>
      </div>

      {quotas.length === 0 ? (
        <span className="text-muted">Usage quota not configured.</span>
      ) : (
        <div className="flex flex-col items-end gap-1.5">
          {quotas.map((quota) => (
            <div
              key={`${quota.provider}-${quota.authMode ?? ""}`}
              data-provider={quota.provider}
              className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1"
            >
              <span className="font-medium">{providerLabel(quota)}</span>
              <Badge tone={STATE_BADGE[quota.state].tone}>{STATE_BADGE[quota.state].label}</Badge>
              <span>
                {formatCost(quota.usedUsd)} used of {formatCost(quota.limitUsd)} (
                {CADENCE_LABEL[quota.cadence]}) · {formatCost(quota.remainingUsd)} remaining
              </span>
              <span className="text-muted">Resets {formatDateTime(quota.resetAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
