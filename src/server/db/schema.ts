import { sql } from "drizzle-orm";
import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type { LlmProviderId } from "../config/llm-providers";
import type { ProviderId } from "../git/providers/types";
import type {
  ArtifactType,
  Criticality,
  Difficulty,
  FailureKind,
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
  /** Defaults to `github` so rows written before multi-provider stay valid. */
  provider: text("provider").$type<ProviderId>().notNull().default("github"),
  url: text("url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  /**
   * Name of the environment variable holding the credential — never the value.
   * `NULL` falls back to the provider's conventional variable.
   */
  credentialRef: text("credential_ref"),
  /** Overrides the provider's default Basic-auth username. */
  credentialUsername: text("credential_username"),
  /** API root for self-hosted instances; `NULL` uses the provider's default. */
  apiBaseUrl: text("api_base_url"),
  /**
   * Free-text project documentation (architecture, layout, conventions),
   * entered once at connection time and handed to every stage prompt. `NULL`
   * means none was provided.
   */
  context: text("context"),
  /**
   * Operator-configured verification commands, run by the worker's
   * `VERIFICATION` stage rather than claimed by any agent. `NULL` means "no
   * such command" — see `verification.ts` and `createRepoSchema`'s command
   * field, which normalises `''` to `undefined` before it reaches here.
   */
  verifyInstall: text("verify_install"),
  verifyBuild: text("verify_build"),
  verifyTest: text("verify_test"),
  verifyLint: text("verify_lint"),
  verifyTimeoutSeconds: integer("verify_timeout_seconds").notNull().default(600),
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
    /** Opt-in, chosen at creation: park at HUMAN_CODE_REVIEW before delivery. */
    requireHumanCodeReview: integer("require_human_code_review", { mode: "boolean" })
      .notNull()
      .default(false),
    branchName: text("branch_name"),
    /**
     * The branch name a developer asked for at creation time, before it is
     * known whether the task will ever reach a workspace-needing stage.
     * `branchName` above stays lazily populated exactly as before; this
     * column only records intent. See `prepareWorkspace` for how the two
     * combine.
     */
    customBranchName: text("custom_branch_name"),
    /**
     * Holds either a real change request or a pre-filled compare/creation
     * page, depending on `deliveryOutcome` below — the column never says
     * which by itself. See `deliveryOutcome`'s comment.
     */
    prUrl: text("pr_url"),
    /**
     * Which branch of `createChangeRequest`'s result actually happened:
     * `'created'` means `prUrl` is a real change request; `'manual'` means
     * the branch was pushed but the API call failed or no credential was
     * configured, and `prUrl` is a compare link the user must act on by
     * hand. `NULL` for a task that has not reached `DELIVERY` yet.
     */
    deliveryOutcome: text("delivery_outcome").$type<"created" | "manual">(),
    /** Why the outcome was `manual` — rendered in the detail-page banner. */
    deliveryReason: text("delivery_reason"),
    /** The change request's number/iid, from `ChangeRequestRef.id`. `NULL` unless `deliveryOutcome === 'created'`. */
    prNumber: integer("pr_number"),
    /** `NULL` | `'open'` | `'merged'` | `'closed'` — only ever set to `'open'` today; nothing yet polls it forward. */
    prState: text("pr_state").$type<"open" | "merged" | "closed">(),
    workspacePath: text("workspace_path"),
    /** Populated when the task reaches FAILED or REJECTED. */
    failureReason: text("failure_reason"),
    /**
     * The stage a retry should re-run, and why it failed. Written by the same
     * statement that sets `currentStage = 'FAILED'`; cleared on a successful
     * retry. `NULL` for a `FAILED` row that predates this column (see the
     * backfill in `migrations.ts`) — retry refuses those explicitly rather
     * than guessing from `stage_runs`.
     */
    failedStage: text("failed_stage").$type<Stage>(),
    failureKind: text("failure_kind").$type<FailureKind>(),
    /**
     * Extra rework cycles a `rework_exhausted` retry has granted this task,
     * on top of `settings.reworkMaxCycles`. Monotonic and per-task — see
     * `spec-retry-recovery.md` §6.
     */
    reworkBudgetGrant: integer("rework_budget_grant").notNull().default(0),
    /**
     * Per-task spend ceiling, checked by `scheduleStage` before enqueueing
     * each stage — `NULL` means no ceiling. See `settings.maxCostPerStageUsd`
     * for the per-stage counterpart, enforced by the provider instead.
     */
    maxCostUsd: real("max_cost_usd"),
    /**
     * "Finish the current stage, then wait instead of scheduling the next
     * one." Checked by `scheduleStage`, cleared by `resumeTask`. Not a
     * `TaskStatus` — see `stages.ts`'s note on why `on_queue`/`gate_queued`
     * are already the two exceptions to "status is derived from stage".
     */
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    /**
     * Soft-delete timestamp — `NULL` means visible everywhere. Set by
     * `archiveTask`/cleared by `unarchiveTask`; see `spec-board-at-scale.md`
     * §5. Every row and every `/usage` total survives archiving: only the
     * board, the list view and the dependency picker hide the task.
     */
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (table) => [
    index("tasks_status_idx").on(table.status),
    index("tasks_stage_idx").on(table.currentStage),
    index("tasks_archived_idx").on(table.archivedAt),
    index("tasks_repo_idx").on(table.repoId),
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
    /**
     * The exact prompt this run was given — see `spec-audit-trail.md` §4.
     * Written immediately before the provider is invoked, not after, so a run
     * that fails still has it. `NULL` on rows written before this migration
     * and on the `DELIVERY` run, which never calls `runStage`.
     */
    systemPrompt: text("system_prompt"),
    userPrompt: text("user_prompt"),
    model: text("model"),
    provider: text("provider").$type<LlmProviderId>(),
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
 * Files attached to a task's description (images, PDF, JSON, XML).
 *
 * Stored as a BLOB rather than on disk: a `CREATED` task has no
 * `workspacePath` yet (it exists only once the Developer stage clones the
 * repo), and the workspace directory is deleted by `scheduleWorkspaceCleanup`
 * on a retention timer — either would be the wrong home for something the
 * brief treats as part of the task's permanent record.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [index("attachments_task_idx").on(table.taskId)],
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
    /**
     * Name of the API token that authenticated the request this event
     * resulted from, e.g. `"CI"`. `NULL` for every browser-originated action
     * — see `spec-board-at-scale.md` §11.3 and `server/auth/tokens.ts`'s
     * `AsyncLocalStorage` context, which is how this gets set without
     * threading an `actor` parameter through every orchestrator function.
     */
    actor: text("actor"),
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

/**
 * `taskId` may not be started until every task it references here is
 * `COMPLETED` — see `assertPrerequisitesMet` in `../pipeline/orchestrator`.
 *
 * Both columns cascade: a deleted task can only ever be a still-`CREATED`
 * one (`deleteCreatedTask`'s restriction), so dropping either side of the
 * edge along with the row is safe — see `techplan.md`'s "Deleting a
 * prerequisite" risk note.
 */
export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [
    uniqueIndex("task_dependencies_pair_idx").on(table.taskId, table.dependsOnTaskId),
    index("task_dependencies_task_idx").on(table.taskId),
    index("task_dependencies_depends_on_idx").on(table.dependsOnTaskId),
  ],
);

/**
 * One row per mechanical verification command (install/build/test/lint),
 * owned by the `VERIFICATION` stage run that produced it. The audit record:
 * outlives the workspace (see `executeCleanup`), so "what passed" is always
 * answerable after the clone is gone.
 */
export const verificationRuns = sqliteTable(
  "verification_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stageRunId: text("stage_run_id")
      .notNull()
      .references(() => stageRuns.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"install" | "build" | "test" | "lint">().notNull(),
    command: text("command").notNull(),
    /** `NULL` when the process was killed by the timeout. */
    exitCode: integer("exit_code"),
    timedOut: integer("timed_out", { mode: "boolean" }).notNull().default(false),
    durationMs: integer("duration_ms").notNull(),
    stdoutTail: text("stdout_tail").notNull().default(""),
    stderrTail: text("stderr_tail").notNull().default(""),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => [
    index("verification_runs_task_idx").on(table.taskId),
    index("verification_runs_stage_run_idx").on(table.stageRunId),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Optional bearer tokens for `/api/*` — `spec-board-at-scale.md` §11.
 *
 * `tokenHash` only: the raw secret is never persisted anywhere, by any
 * caller (see `createApiToken` in `server/auth/tokens.ts`, the only writer).
 * A label (`name`), not an identity — see §11.3.
 */
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  lastUsedAt: integer("last_used_at"),
});

export const JOB_KINDS = [
  "run_stage",
  "deliver",
  "verify",
  "cleanup_workspace",
  /**
   * Wakes `promoteQueue` at a quota period's `nextReset`, so a task parked at
   * `on_queue` on a `QuotaError` is re-checked without waiting for an
   * unrelated slot-freeing transition. Its `taskId` is whichever task's park
   * triggered it — the job's effect (`promoteQueue()`) is global, not
   * task-specific, so no two of these are ever enqueued at once (§4.5).
   */
  "quota_wake",
] as const;
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

/** Always the single row `id = 'worker'` (§7.2). */
export const workerStatus = sqliteTable("worker_status", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  heartbeatAt: integer("heartbeat_at").notNull(),
  pid: integer("pid"),
  version: text("version"),
  /** NULL when the worker is idle between jobs. */
  activeJobId: text("active_job_id"),
  activeTaskId: text("active_task_id"),
});

export type RepoRow = typeof repos.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type StageRunRow = typeof stageRuns.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type VerificationRunRow = typeof verificationRuns.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type WorkerStatusRow = typeof workerStatus.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
