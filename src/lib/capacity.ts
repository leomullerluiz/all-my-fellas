/**
 * Shared "why can't I start this" copy.
 *
 * `TaskCardMenu`, `TaskControls`, and the batch-start summary all need to say
 * the same thing when a slot isn't free, so the string lives here once rather
 * than being hand-copied at each call site.
 */
export function capacityBlockedReason(capacity: {
  slotAvailable: boolean;
  limit: number;
  blocking: Array<{ title: string }>;
}): string | null {
  if (capacity.slotAvailable) return null;
  return (
    `Limit of ${capacity.limit} task${capacity.limit === 1 ? "" : "s"} in progress reached` +
    (capacity.blocking[0] ? ` — ${capacity.blocking[0].title} is still running.` : ".")
  );
}
