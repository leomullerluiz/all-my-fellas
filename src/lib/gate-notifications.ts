import { isGate } from "@/server/pipeline/stages";
// From `@/server/events/types`, not `@/server/events/store`: `store.ts`
// imports the SQLite client, which cannot be bundled for the browser — same
// reasoning `live-log.tsx` already documents for its own import.
import type { PipelineEvent } from "@/server/events/types";

/**
 * Pure, browser-safe helpers behind the desktop-notification feature
 * (`stories.md` S1–S3). Kept out of `gate-approval-notifier.tsx` so the
 * gate-filtering, copy-building and dedup logic can be unit tested on plain
 * objects, without a real `EventSource` or `Notification` — see
 * `tests/gate-notifications.test.ts`.
 */

/**
 * The shape delivered by `GET /api/events/stream`'s `data:` field — see that
 * route's `send()` call. `id` is the stream's own monotonically increasing
 * cursor (`events.id`, a genuinely global key), distinct from the per-task
 * `seq` on `StoredEvent`.
 */
export type StreamEnvelope = {
  id: number;
  taskId: string;
  seq: number;
  stageRunId: string | null;
  createdAt: number;
  payload: PipelineEvent;
};

/** True only for a `gate_opened` event whose `gate` is one of the three approval gates. */
export function isApprovalGateOpened(envelope: StreamEnvelope): boolean {
  return envelope.payload.type === "gate_opened" && isGate(envelope.payload.gate);
}

/**
 * Title/body for the desktop `Notification`. Both the task title and the
 * phrase "awaiting your approval" must appear somewhere in the pair — S3's
 * acceptance criterion checks the combination, not either field alone.
 */
export function buildGateNotificationCopy(taskTitle: string): { title: string; body: string } {
  return {
    title: taskTitle,
    body: `"${taskTitle}" is awaiting your approval.`,
  };
}

/** Whether a `Notification` may be constructed at all, given the current setting and permission. */
export function canShowBrowserNotifications(
  browserEnabled: boolean,
  permission: NotificationPermission | undefined,
): boolean {
  return browserEnabled && permission === "granted";
}

/**
 * Dedup + "don't re-notify after reload" in one mechanism: event ids are
 * strictly increasing, so "id <= last processed id" is both the dedup check
 * (a replayed event has the same id) and the reload check (a persisted
 * cursor from before reload already covers every pre-existing gate).
 */
export type CursorGate = {
  /** `true` if `id` is newly seen (and the cursor advanced); `false` if already processed. */
  advance(id: number): boolean;
  readonly value: number;
};

export function createCursorGate(initialId = 0): CursorGate {
  let cursor = initialId;
  return {
    advance(id: number): boolean {
      if (id <= cursor) return false;
      cursor = id;
      return true;
    },
    get value() {
      return cursor;
    },
  };
}
