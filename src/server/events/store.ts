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

/** The four commands the `VERIFICATION` stage can run, in execution order. */
export type VerificationKind = "install" | "build" | "test" | "lint";

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
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  /** What the `VERIFICATION` stage is about to run, before anything spawns. */
  | { type: "verification_started"; commands: VerificationKind[] }
  | { type: "verification_command_started"; kind: VerificationKind; command: string }
  /** Buffered — see `runVerification`'s flush interval, not one event per line. */
  | { type: "verification_output"; kind: VerificationKind; stream: "stdout" | "stderr"; chunk: string }
  | {
      type: "verification_command_finished";
      kind: VerificationKind;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
    }
  | {
      type: "verification_finished";
      status: "passed" | "failed" | "skipped" | "errored";
      reason?: string;
    };

/**
 * Every `PipelineEvent` variant's `type`, derived from the union rather than
 * hand-maintained. Consumers that dispatch or subscribe per event name (the
 * SSE route, `LiveLog`) iterate this instead of their own list, so a new
 * variant added above cannot compile while still being unreachable in the UI
 * — the exact gap a hand-maintained array left open for the five variants
 * this type was introduced for.
 *
 * `Record<PipelineEvent["type"], true>` rather than a plain `as const` array:
 * a mapped-type `Record` over a literal union desugars to one required
 * property per member, so `satisfies` rejects both a missing and an
 * extraneous key at compile time — a plain array assertion only catches the
 * "extra" direction.
 */
const PIPELINE_EVENT_TYPE_SET = {
  task_created: true,
  task_started: true,
  task_edited: true,
  stage_started: true,
  stage_finished: true,
  stage_failed: true,
  agent_text: true,
  agent_thinking: true,
  agent_tool_use: true,
  agent_tool_denied: true,
  artifact_saved: true,
  gate_opened: true,
  gate_decided: true,
  git: true,
  pr_opened: true,
  task_finished: true,
  log: true,
  verification_started: true,
  verification_command_started: true,
  verification_output: true,
  verification_command_finished: true,
  verification_finished: true,
} satisfies Record<PipelineEvent["type"], true>;

export const PIPELINE_EVENT_TYPES = Object.keys(
  PIPELINE_EVENT_TYPE_SET,
) as PipelineEvent["type"][];

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
