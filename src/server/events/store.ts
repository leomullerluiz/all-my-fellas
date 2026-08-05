import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { LlmProviderId } from "../config/llm-providers";
import { db } from "../db/client";
import { events } from "../db/schema";
import type { Stage } from "../pipeline/stages";

/**
 * Append-only event log, the only channel between the worker and the browser.
 *
 * The worker writes; the SSE route tails by `seq`. Nothing else coordinates the
 * two processes, which is what keeps the MVP free of a queue or broker.
 */

export type PipelineEvent =
  | { type: "task_created"; title: string }
  | { type: "task_started" }
  /** Field names only — the current values already live on the task row. */
  | { type: "task_edited"; fields: string[] }
  | { type: "stage_started"; stage: Stage; attempt: number; model?: string; provider?: LlmProviderId }
  | { type: "stage_finished"; stage: Stage; attempt: number; costUsd: number }
  | { type: "stage_failed"; stage: Stage; attempt: number; error: string }
  | { type: "agent_text"; text: string }
  | { type: "agent_thinking" }
  | { type: "agent_tool_use"; tool: string; summary: string }
  | { type: "agent_tool_denied"; tool: string; reason: string }
  | { type: "artifact_saved"; artifactType: string }
  | { type: "gate_opened"; gate: Stage }
  | { type: "gate_decided"; gate: Stage; decision: string; comment?: string }
  | { type: "git"; message: string }
  | { type: "pr_opened"; url: string }
  | { type: "task_finished"; stage: Stage; reason?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

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
