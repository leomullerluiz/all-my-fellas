import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";

import { getCurrentActor } from "../auth/tokens";
import { db } from "../db/client";
import { events } from "../db/schema";
import { dispatchNotification } from "../notifications/dispatch";
import type { PipelineEvent } from "./types";

/**
 * Append-only event log, the only channel between the worker and the browser.
 *
 * The worker writes; the SSE route tails by `seq`. Nothing else coordinates the
 * two processes, which is what keeps the MVP free of a queue or broker.
 *
 * The event *vocabulary* (`PipelineEvent`, `PIPELINE_EVENT_TYPES`,
 * `VerificationKind`) lives in `./types` and is re-exported here — see that
 * module for why: this file pulls in `db` (`better-sqlite3`), which cannot be
 * bundled for the browser, so a client component needing the types (or the
 * runtime `PIPELINE_EVENT_TYPES` tuple) must import `./types` directly.
 */
export type { PipelineEvent, VerificationKind } from "./types";
export { PIPELINE_EVENT_TYPES } from "./types";

export type StoredEvent = {
  seq: number;
  taskId: string;
  stageRunId: string | null;
  type: string;
  payload: PipelineEvent;
  createdAt: number;
  /** The API token's name, when this event came from a token-authenticated
   *  request; `null` for every browser-originated action (§11.3). */
  actor: string | null;
};

/**
 * Appends an event and returns its sequence number.
 *
 * The read-then-insert runs inside a transaction so two concurrent stage runs
 * on the same task cannot collide on `seq`.
 */
export function appendEvent(
  taskId: string,
  stageRunId: string | null,
  payload: PipelineEvent,
): number {
  const seq = db.transaction((tx) => {
    const row = tx
      .select({ maxSeq: sql<number | null>`max(${events.seq})` })
      .from(events)
      .where(eq(events.taskId, taskId))
      .get();

    const nextSeq = (row?.maxSeq ?? 0) + 1;
    tx.insert(events)
      .values({
        taskId,
        stageRunId,
        seq: nextSeq,
        type: payload.type,
        payloadJson: JSON.stringify(payload),
        actor: getCurrentActor(),
      })
      .run();
    return nextSeq;
  });

  // Only reached once the transaction above has committed — a rollback
  // throws out of `db.transaction` and this line never runs (§8.1). Not
  // awaited: the caller (often mid-pipeline, on the worker's only thread of
  // control) should not stall on an outbound HTTP call for a notification.
  dispatchNotification(taskId, payload).catch((error) => {
    console.error(`[notifications] dispatch threw unexpectedly: ${String(error)}`);
  });

  return seq;
}

function toStoredEvent(row: typeof events.$inferSelect): StoredEvent {
  return {
    seq: row.seq,
    taskId: row.taskId,
    stageRunId: row.stageRunId,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as PipelineEvent,
    createdAt: row.createdAt,
    actor: row.actor,
  };
}

/** Reads events after `afterSeq`, oldest first. Used by the SSE tail. */
export function readEvents(taskId: string, afterSeq = 0, limit = 500): StoredEvent[] {
  return db
    .select()
    .from(events)
    .where(and(eq(events.taskId, taskId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq))
    .limit(limit)
    .all()
    .map(toStoredEvent);
}

export type GlobalStoredEvent = StoredEvent & { id: number };

/**
 * Reads events after `afterId`, oldest first, across every task — the global
 * counterpart to {@link readEvents}, cursored on `events.id` (a genuinely
 * global `AUTOINCREMENT` primary key) rather than `seq` (per-task). Backs the
 * board-wide activity stream (§8.2); reuses the same poll-and-cursor shape
 * the per-task route already uses, with no separate backpressure design
 * (§13.6 — an open question this spec set does not resolve).
 */
export function readEventsSince(afterId = 0, limit = 500): GlobalStoredEvent[] {
  return db
    .select()
    .from(events)
    .where(gt(events.id, afterId))
    .orderBy(asc(events.id))
    .limit(limit)
    .all()
    .map((row) => ({ ...toStoredEvent(row), id: row.id }));
}

/**
 * Reverse-chronological events across every task, for the `/activity` feed's
 * initial paint (S6 §6.3). `readEventsSince` stays ascending, tail-oriented,
 * for live polling; this is the "load the most recent N" counterpart,
 * optionally paged further back with `beforeId`.
 */
export function listRecentEvents(beforeId?: number, limit = 100): GlobalStoredEvent[] {
  return db
    .select()
    .from(events)
    .where(beforeId !== undefined ? lt(events.id, beforeId) : undefined)
    .orderBy(desc(events.id))
    .limit(limit)
    .all()
    .map((row) => ({ ...toStoredEvent(row), id: row.id }));
}
