import { Badge, type BadgeProps } from "@/components/ui/badge";
import { formatCost, formatDateTime } from "@/lib/utils";
import type { Cadence, QuotaStatus } from "@/server/usage/quota";

/**
 * Bottom-of-dashboard bar: today's spend (S1) plus, when a quota limit is
 * configured, how much of it is used and when it resets (S2), rendered in a
 * visually distinct state as usage approaches or exceeds the limit (S3).
 *
 * Pure/presentational — `page.tsx` supplies both numbers already computed by
 * `spendToday()`/`resolveQuotaStatus()`, so this component needs no data
 * access of its own and follows the same refresh cadence as the rest of the
 * server-rendered page (no client-side polling is introduced here).
 */

const CONTAINER_TONE: Record<QuotaStatus["state"], string> = {
  not_configured: "border-border bg-surface",
  normal: "border-border bg-surface",
  warning: "border-warning/40 bg-warning/10",
  exceeded: "border-danger/40 bg-danger/10",
};

const STATE_BADGE: Record<Exclude<QuotaStatus["state"], "not_configured">, {
  label: string;
  tone: BadgeProps["tone"];
}> = {
  normal: { label: "Within quota", tone: "success" },
  warning: { label: "Approaching quota", tone: "warning" },
  exceeded: { label: "Quota exceeded", tone: "danger" },
};

const CADENCE_LABEL: Record<Cadence, string> = {
  daily: "daily",
  hourly: "hourly",
};

export function UsageBar({
  spendToday,
  quota,
}: {
  spendToday: number;
  quota: QuotaStatus;
}) {
  // Subscription usage comes out of a Pro/Max allowance, not a bill — the
  // figure must never read as money actually spent. See `spec-cost-forecast.md` §2.
  const spendLabel = quota.authMode === "subscription" ? "est. spent today" : "spent today";

  return (
    <div
      data-state={quota.state}
      className={`mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border px-4 py-3 text-xs ${CONTAINER_TONE[quota.state]}`}
    >
      <div>
        <span className="text-muted">{spendLabel}</span>{" "}
        <span className="font-medium">{formatCost(spendToday)}</span>
      </div>

      {quota.state === "not_configured" ? (
        <span className="text-muted">Usage quota not configured.</span>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Badge tone={STATE_BADGE[quota.state].tone}>{STATE_BADGE[quota.state].label}</Badge>
          <span>
            {formatCost(quota.usedUsd)} used of {formatCost(quota.limitUsd)} (
            {CADENCE_LABEL[quota.cadence]}) · {formatCost(quota.remainingUsd)} remaining
          </span>
          <span className="text-muted">Resets {formatDateTime(quota.resetAt)}</span>
        </div>
      )}
    </div>
  );
}
