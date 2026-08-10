import { providerLabel } from "@/components/usage-bar";
import type { QuotaStatus } from "@/server/usage/quota";

/**
 * The worst-state quota warning across every configured provider, or `null`
 * once every configured provider is within its limit (or none is
 * configured).
 *
 * `UsageBar` itself renders on the new-task form and the task-detail Start
 * control (stories.md S4), but neither the dashboard's "Start selected"
 * batch button nor a single card's dropdown Start item has room for the full
 * bar — one is a header action, the other a menu item a few lines tall. Both
 * need *some* signal at the point spend is committed rather than none, so
 * they share this one-line reduction instead of the full bar.
 */
export type QuotaWarning = { state: "warning" | "exceeded"; message: string };

export function worstQuotaWarning(quotas: QuotaStatus[]): QuotaWarning | null {
  const exceeded = quotas.find((quota) => quota.state === "exceeded");
  if (exceeded) {
    return { state: "exceeded", message: `${providerLabel(exceeded)} quota exceeded.` };
  }

  const warning = quotas.find((quota) => quota.state === "warning");
  if (warning) {
    return { state: "warning", message: `Approaching ${providerLabel(warning)} quota.` };
  }

  return null;
}
