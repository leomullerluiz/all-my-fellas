import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type {
  ArtifactType,
  Criticality,
  Difficulty,
  Gate,
  GateDecision,
  Priority,
  Stage,
  StageRunStatus,
  TaskStatus,
} from "../pipeline/stages";

/**
 * SQLite schema for the delivery pipeline.
 *
 * Timestamps are stored as integer epoch milliseconds so both processes agree
 * regardless of locale, and JSON payloads are stored as text.
 */

const now = sql`(unixepoch() * 1000)`;

export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").$type<"github">().notNull().default("github"),
  url: text("url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: integer("created_at").notNull().default(now),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("queued"),
    currentStage: text("current_stage").$type<Stage>().notNull().default("CREATED"),
    priority: text("priority").$type<Priority>().notNull().default("medium"),
    /** Estimated by the Architect: S / M / L. */
    difficulty: text("difficulty").$type<Difficulty>(),
    /** Estimated by the Architect: low / medium / high. */
    criticality: text("criticality").$type<Criticality>(),
    branchName: text("branch_name"),
    prUrl: text("pr_url"),
    workspacePath: text("workspace_path"),
    /** Populated when the task reaches FAILED or REJECTED. */
    failureReason: text("failure_reason"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (table) => [
    index("tasks_status_idx").on(table.status),
    index("tasks_stage_idx").on(table.currentStage),
  ],
);

export const stageRuns = sqliteTable(
  "stage_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stage: text("stage").$type<Stage>().notNull(),
    /** 1-based; incremented when QA sends work back to Development. */
    attempt: integer("attempt").notNull().default(1),
    status: text("status").$type<StageRunStatus>().notNull().default("pending"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    maxTurns: integer("max_turns"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [
    index("stage_runs_task_idx").on(table.taskId),
    uniqueIndex("stage_runs_task_stage_attempt_idx").on(
      table.taskId,
      table.stage,
      table.attempt,
    ),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stageRunId: text("stage_run_id")
      .notNull()
      .references(() => stageRuns.id, { onDelete: "cascade" }),
    type: text("type").$type<ArtifactType>().notNull(),
    contentMd: text("content_md").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [index("artifacts_task_type_idx").on(table.taskId, table.type)],
);

/**
 * Full agent transcripts. Kept for auditing and debugging only — the pipeline
 * never feeds these back into a later stage (minimum-context handoff).
 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    stageRunId: text("stage_run_id")
      .notNull()
      .references(() => stageRuns.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    transcriptJson: text("transcript_json").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [index("agent_runs_stage_run_idx").on(table.stageRunId)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stageRunId: text("stage_run_id"),
    /** Per-task monotonic sequence used as the SSE cursor. */
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [uniqueIndex("events_task_seq_idx").on(table.taskId, table.seq)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    gate: text("gate").$type<Gate>().notNull(),
    decision: text("decision").$type<GateDecision>().notNull(),
    comment: text("comment"),
    decidedAt: integer("decided_at").notNull().default(now),
  },
  (table) => [index("approvals_task_idx").on(table.taskId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const JOB_KINDS = ["run_stage", "deliver", "cleanup_workspace"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["pending", "claimed", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<JobKind>().notNull(),
    /** Job payload (e.g. which stage run to execute). */
    payloadJson: text("payload_json").notNull().default("{}"),
    /** Epoch ms; the worker ignores jobs scheduled in the future. */
    runAfter: integer("run_after").notNull().default(now),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [index("jobs_status_run_after_idx").on(table.status, table.runAfter)],
);

export type RepoRow = typeof repos.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type StageRunRow = typeof stageRuns.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
