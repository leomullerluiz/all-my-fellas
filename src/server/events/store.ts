import { and, asc, eq, gt, sql } from "drizzle-orm";

import { db } from "../db/client";
import { events } from "../db/schema";
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
  return db.transaction((tx) => {
    const row = tx
      .select({ maxSeq: sql<number | null>`max(${events.seq})` })
      .from(events)
      .where(eq(events.taskId, taskId))
      .get();

    const seq = (row?.maxSeq ?? 0) + 1;
    tx.insert(events)
      .values({
        taskId,
        stageRunId,
        seq,
        type: payload.type,
        payloadJson: JSON.stringify(payload),
      })
      .run();
    return seq;
  });
}

function toStoredEvent(row: typeof events.$inferSelect): StoredEvent {
  return {
    seq: row.seq,
    taskId: row.taskId,
    stageRunId: row.stageRunId,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as PipelineEvent,
    createdAt: row.createdAt,
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
