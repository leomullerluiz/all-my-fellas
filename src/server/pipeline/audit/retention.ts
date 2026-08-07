import { getSettings } from "../../settings/store";
import { sweepTranscriptRetention } from "../../tasks/service";

/**
 * The transcript retention sweep — spec-audit-trail.md §11.
 *
 * Not a `jobs` row: `jobs.task_id` is `NOT NULL` by design, and a global
 * maintenance sweep has no task to hang off. Run by the worker instead, once
 * at startup and then on its own periodic interval, because the worker
 * already owns long-running maintenance and the web process must not do a
 * multi-megabyte `UPDATE` inside a request.
 *
 * A no-op when `transcriptRetentionDays` is `null` — the default, "keep
 * forever".
 */
export function runMaintenanceSweep(): { swept: number } {
  const { transcriptRetentionDays } = getSettings();
  if (transcriptRetentionDays === null) return { swept: 0 };

  const cutoff = Date.now() - transcriptRetentionDays * 86_400_000;
  const swept = sweepTranscriptRetention(cutoff);
  return { swept };
}
