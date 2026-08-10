import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { LlmProviderId } from "../config/llm-providers";
import { db } from "../db/client";
import { newId } from "../db/ids";
import {
  type AgentRunRow,
  type ApprovalRow,
  type ArtifactRow,
  type AttachmentRow,
  type RepoRow,
  type StageRunRow,
  type TaskRow,
  type VerificationRunRow,
  agentRuns,
  approvals,
  artifacts,
  attachments,
  repos,
  stageRuns,
  taskDependencies,
  tasks,
  verificationRuns,
} from "../db/schema";
import { appendEvent } from "../events/store";
import type { ProviderId } from "../git/providers/types";
import { redactSecrets } from "../pipeline/audit/redact";
import type {
  ArtifactType,
  Criticality,
  Difficulty,
  Gate,
  GateDecision,
  Priority,
  Stage,
  StageRunStatus,
} from "../pipeline/stages";
import { statusForStage } from "../pipeline/stages";
import type { CommandResult } from "../pipeline/verification";
import { cacheTokenFixAppliedAt } from "../settings/store";

/** Data access for tasks and their related rows, shared by web and worker. */

export type TaskWithRepo = TaskRow & { repo: RepoRow };

export function listRepos(): RepoRow[] {
  return db.select().from(repos).orderBy(desc(repos.createdAt)).all();
}

export function getRepo(id: string): RepoRow | null {
  return db.select().from(repos).where(eq(repos.id, id)).get() ?? null;
}

export function createRepo(input: {
  name: string;
  url: string;
  defaultBranch: string;
  provider?: ProviderId;
  credentialRef?: string | null;
  credentialUsername?: string | null;
  apiBaseUrl?: string | null;
  context?: string | null;
}): RepoRow {
  const row = db
    .insert(repos)
    .values({
      id: newId("repo"),
      name: input.name,
      provider: input.provider ?? "github",
      url: input.url,
      defaultBranch: input.defaultBranch,
      credentialRef: input.credentialRef ?? null,
      credentialUsername: input.credentialUsername ?? null,
      apiBaseUrl: input.apiBaseUrl ?? null,
      context: input.context ?? null,
    })
    .returning()
    .get();
  return row;
}

/**
 * Updates a repository's verification commands only — the sole reachable
 * mutation for `repos.verify_*`. `undefined` leaves a field unchanged;
 * `createRepoSchema`'s command field already normalises a cleared form value
 * to `undefined` before it reaches here, so there is no way to write `''`.
 */
export function updateRepoVerificationCommands(
  id: string,
  fields: {
    verifyInstall?: string;
    verifyBuild?: string;
    verifyTest?: string;
    verifyLint?: string;
    verifyTimeoutSeconds?: number;
  },
): RepoRow | null {
  const patch: Partial<RepoRow> = {};
  if ("verifyInstall" in fields) patch.verifyInstall = fields.verifyInstall ?? null;
  if ("verifyBuild" in fields) patch.verifyBuild = fields.verifyBuild ?? null;
  if ("verifyTest" in fields) patch.verifyTest = fields.verifyTest ?? null;
  if ("verifyLint" in fields) patch.verifyLint = fields.verifyLint ?? null;
  if (fields.verifyTimeoutSeconds !== undefined) patch.verifyTimeoutSeconds = fields.verifyTimeoutSeconds;

  if (Object.keys(patch).length === 0) return getRepo(id);

  return db.update(repos).set(patch).where(eq(repos.id, id)).returning().get() ?? null;
}

export function deleteRepo(id: string): boolean {
  const inUse = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.repoId, id))
    .get();
  if ((inUse?.count ?? 0) > 0) return false;

  const removed = db.delete(repos).where(eq(repos.id, id)).returning({ id: repos.id }).all();
  return removed.length > 0;
}

export function getTask(id: string): TaskRow | null {
  return db.select().from(tasks).where(eq(tasks.id, id)).get() ?? null;
}

export function getTaskWithRepo(id: string): TaskWithRepo | null {
  const row = db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(eq(tasks.id, id))
    .get();
  return row ? { ...row.task, repo: row.repo } : null;
}

/**
 * Escapes SQLite `LIKE` wildcards (`%`, `_`) in free-text search input so a
 * literal percent or underscore in a title/description search does not act
 * as a wildcard. Paired with `ESCAPE '\'` in the `LIKE` clause below.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export type ListTasksFilter = {
  status?: string;
  /** Narrows to one repository. */
  repoId?: string;
  priority?: Priority;
  /** Case-insensitive substring match against title or description. */
  q?: string;
  /**
   * `false` (the default) excludes archived tasks — see
   * `spec-board-at-scale.md` §5.2. `true` includes them (`?archived=1`).
   */
  includeArchived?: boolean;
};

export function listTasks(filter?: ListTasksFilter): TaskWithRepo[] {
  const conditions = [];
  if (filter?.status) conditions.push(eq(tasks.status, filter.status as TaskRow["status"]));
  if (filter?.repoId) conditions.push(eq(tasks.repoId, filter.repoId));
  if (filter?.priority) conditions.push(eq(tasks.priority, filter.priority));
  if (filter?.q) {
    // SQLite's `LIKE` is already case-insensitive over ASCII, so no
    // `lower()` wrapping is needed on either side. `drizzle-orm`'s `like()`
    // helper has no `ESCAPE` clause, so this is built directly to keep a
    // literal `%`/`_` in the search text from acting as a wildcard.
    const pattern = `%${escapeLikePattern(filter.q)}%`;
    conditions.push(
      sql`(${tasks.title} LIKE ${pattern} ESCAPE '\\' OR ${tasks.description} LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (!filter?.includeArchived) conditions.push(isNull(tasks.archivedAt));

  const rows = db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.createdAt))
    .all();
  return rows.map((row) => ({ ...row.task, repo: row.repo }));
}

/**
 * Archives a task: sets `archived_at`, which hides it from the board, the
 * list view and the dependency picker while every row (cost, artifacts,
 * approvals) stays intact and every `/usage` total keeps counting it — see
 * `spec-board-at-scale.md` §5.2.
 */
export function archiveTask(id: string): TaskRow | null {
  return updateTask(id, { archivedAt: Date.now() });
}

/** Clears `archived_at`, restoring `id` to the board, list view and picker. */
export function unarchiveTask(id: string): TaskRow | null {
  return updateTask(id, { archivedAt: null });
}

/** A task offered as a selectable prerequisite in the "Depends on" picker. */
export type DependencyOption = { id: string; title: string; repoId: string; repoName: string };

/**
 * Statuses that disqualify a task as a prerequisite: `completed` because a
 * finished task is not a meaningful one, and the other three because they can
 * never reach `COMPLETED` — picking one would park the dependent task forever
 * (see `incompleteDependencies`).
 */
const UNSELECTABLE_DEPENDENCY_STATUSES: ReadonlySet<TaskRow["status"]> = new Set([
  "completed",
  "rejected",
  "failed",
  "cancelled",
]);

/**
 * Candidates for the "Depends on" picker: every task except `excludeId`
 * (the task being edited cannot depend on itself), every task in an
 * unselectable status, and every archived task — an archived task is
 * unselectable for the same reason a terminal one is (it will never
 * meaningfully block or unblock the dependent), and `listTasks()`'s default
 * of excluding `archivedAt !== null` already does the filtering; this stays
 * unconditional (no `includeArchived` escape hatch) per
 * `spec-board-at-scale.md` §5.3.
 *
 * `repoId` narrows the result to a single repository, since a prerequisite is
 * only meaningful against the code the task itself will change. Passing
 * nothing (or an empty string) returns candidates across every repository —
 * which is what the forms ask for, so the client can re-filter as the
 * "Repository" select changes without another round trip.
 *
 * Relies on `tasks.status` staying in lockstep with `currentStage` — enforced
 * by convention in `setTaskStage`/`statusForStage`, not by a constraint.
 */
export function listDependencyOptions(excludeId?: string, repoId?: string): DependencyOption[] {
  return listTasks()
    .filter(
      (task) =>
        !UNSELECTABLE_DEPENDENCY_STATUSES.has(task.status) &&
        task.id !== excludeId &&
        (!repoId || task.repoId === repoId),
    )
    .map((task) => ({
      id: task.id,
      title: task.title,
      repoId: task.repoId,
      repoName: task.repo.name,
    }));
}

/** A file ready to persist: already read into memory and validated. */
export type NewAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
};

/**
 * Inserts a task row. The caller is responsible for entering the pipeline via
 * `orchestrator.startTask`, which keeps this module free of a cyclic import.
 *
 * Any attachments are inserted in the same transaction as the task row, so a
 * failed attachment insert cannot leave a task behind with no way to attach
 * the files it was created with.
 */
export function createTask(input: {
  repoId: string;
  title: string;
  description: string;
  priority: Priority;
  requireHumanCodeReview?: boolean;
  attachments?: NewAttachment[];
  /** Task ids that must reach `COMPLETED` before this task can be started. */
  dependsOn?: string[];
  /**
   * Developer-chosen override for the branch the task is developed on.
   * Trimmed and stored as-is; `prepareWorkspace` prefers it over
   * `branchNameFor(...)` when present. Create-only — there is no
   * corresponding field on `EditableTaskFields`.
   */
  branchName?: string;
  /** Per-task spend ceiling; `null`/omitted means no ceiling. */
  maxCostUsd?: number | null;
}): TaskRow {
  const id = newId("task");
  const task = db.transaction(() => {
    const created = db
      .insert(tasks)
      .values({
        id,
        repoId: input.repoId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        requireHumanCodeReview: input.requireHumanCodeReview ?? false,
        customBranchName: input.branchName ?? null,
        maxCostUsd: input.maxCostUsd ?? null,
        status: "queued",
        currentStage: "CREATED",
      })
      .returning()
      .get();

    if (input.attachments && input.attachments.length > 0) {
      insertAttachments(created.id, input.attachments);
    }
    if (input.dependsOn && input.dependsOn.length > 0) {
      insertDependencies(created.id, input.dependsOn);
    }
    return created;
  });

  appendEvent(id, null, { type: "task_created", title: input.title });
  return task;
}

/** Persists a batch of already-validated files against `taskId`. */
export function insertAttachments(taskId: string, files: NewAttachment[]): AttachmentRow[] {
  return files.map((file) =>
    db
      .insert(attachments)
      .values({
        id: newId("att"),
        taskId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.size,
        data: file.buffer,
      })
      .returning()
      .get(),
  );
}

/** Attachment metadata without the file bytes, for list views. */
export type AttachmentMeta = Omit<AttachmentRow, "data">;

export function listAttachments(taskId: string): AttachmentMeta[] {
  return db
    .select({
      id: attachments.id,
      taskId: attachments.taskId,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(eq(attachments.taskId, taskId))
    .orderBy(attachments.createdAt)
    .all();
}

/** Includes the file bytes — only for the download route, never for a list. */
export function getAttachment(id: string): AttachmentRow | null {
  return db.select().from(attachments).where(eq(attachments.id, id)).get() ?? null;
}

/**
 * `taskId`'s attachments, shaped as fresh `NewAttachment`s ready to hand to
 * `createTask`/`insertAttachments` for a duplicate — see `stories.md` S4.
 *
 * Copies the bytes rather than sharing the row: `attachments.data` cascades
 * with its task, so sharing would mean deleting one task's attachments
 * destroys the other's.
 */
export function listAttachmentsForCopy(taskId: string): NewAttachment[] {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.taskId, taskId))
    .orderBy(attachments.createdAt)
    .all()
    .map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.sizeBytes,
      buffer: attachment.data,
    }));
}

/** Removes one attachment, scoped to `taskId` so a foreign id cannot match. */
export function deleteAttachment(taskId: string, attachmentId: string): boolean {
  const removed = db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.taskId, taskId)))
    .returning({ id: attachments.id })
    .all();
  return removed.length > 0;
}

/** A prerequisite task, with enough of its own state to render a block reason. */
export type DependencySummary = {
  id: string;
  title: string;
  status: TaskRow["status"];
  currentStage: Stage;
};

/** Persists a batch of edges from `taskId` to each id in `dependsOn`. */
function insertDependencies(taskId: string, dependsOn: string[]): void {
  for (const dependsOnTaskId of dependsOn) {
    db.insert(taskDependencies)
      .values({ id: newId("dep"), taskId, dependsOnTaskId })
      .run();
  }
}

/** The prerequisite tasks `taskId` depends on, in the order they were added. */
export function listDependencies(taskId: string): DependencySummary[] {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      currentStage: tasks.currentStage,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId))
    .orderBy(taskDependencies.createdAt)
    .all();
}

/**
 * {@link listDependencies}, for every task at once — one query instead of one
 * per task, for the board's aggregate render (`spec-board-at-scale.md` §9.1).
 * A task with no prerequisites has no entry in the returned map; callers
 * default it to `[]`, matching `listDependencies`' own empty-array result.
 */
export function dependenciesByTaskId(): Map<string, DependencySummary[]> {
  const rows = db
    .select({
      taskId: taskDependencies.taskId,
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      currentStage: tasks.currentStage,
      createdAt: taskDependencies.createdAt,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .orderBy(taskDependencies.createdAt)
    .all();

  const byTaskId = new Map<string, DependencySummary[]>();
  for (const row of rows) {
    const list = byTaskId.get(row.taskId) ?? [];
    list.push({ id: row.id, title: row.title, status: row.status, currentStage: row.currentStage });
    byTaskId.set(row.taskId, list);
  }
  return byTaskId;
}

/**
 * The subset of `taskId`'s prerequisites that have not reached `COMPLETED`.
 *
 * Anything else — `queued`, `on_queue`, `running`, `awaiting_gate`, `failed`,
 * `rejected`, `cancelled` — counts as incomplete; there is no silent skip for
 * a prerequisite that failed or was cancelled instead of finishing.
 */
export function incompleteDependencies(taskId: string): DependencySummary[] {
  return listDependencies(taskId).filter((dependency) => dependency.currentStage !== "COMPLETED");
}

/** Replaces `taskId`'s stored prerequisite set with exactly `dependsOn`. */
export function replaceDependencies(taskId: string, dependsOn: string[]): void {
  db.transaction(() => {
    db.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId)).run();
    insertDependencies(taskId, dependsOn);
  });
}

/**
 * Whether adding an edge from `taskId` to every id in `dependsOn` would close
 * a cycle — direct (A depends on B, B already depends on A) or transitive
 * (A -> B -> C -> A).
 *
 * Walks each candidate prerequisite's own prerequisites looking for `taskId`;
 * a self-reference (`taskId` appearing in `dependsOn` itself) is the caller's
 * responsibility to reject separately, since that is a distinct, simpler 400.
 */
export function wouldCreateCycle(taskId: string, dependsOn: string[]): boolean {
  const visited = new Set<string>();
  const stack = [...dependsOn];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dependency of listDependencies(current)) stack.push(dependency.id);
  }
  return false;
}

/**
 * Statuses that occupy a concurrency slot.
 *
 * Only `running` counts: a gated task holds no claimed job, so it does not
 * need a slot to stay honest about what is executing. See
 * `spec-task-queue.md` §8.2. Resuming a gated task back into `run` is itself
 * admission-checked in `decideGate`, which is what keeps the `running` badge
 * truthful now that gated tasks no longer reserve a slot.
 */
export const ACTIVE_STATUSES = ["running"] as const;

export function countActiveTasks(): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(inArray(tasks.status, [...ACTIVE_STATUSES]))
    .get();
  return row?.count ?? 0;
}

/** Titles of the tasks currently holding a slot, so a refusal can name them. */
export function activeTasks(): Array<{ id: string; title: string; status: string }> {
  return db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.status, [...ACTIVE_STATUSES]))
    .orderBy(tasks.updatedAt)
    .all();
}

/**
 * Tasks parked at `on_queue` by `startTasksBatch`, waiting for
 * `orchestrator.promoteQueue` to start them as slots free up.
 */
export function queuedTasks(): TaskRow[] {
  return db.select().from(tasks).where(eq(tasks.status, "on_queue")).all();
}

/**
 * Tasks parked at `gate_queued` by `decideGate`, whose approved decision is
 * waiting for `orchestrator.promoteQueue` to resume them as slots free up.
 */
export function gateQueuedTasks(): TaskRow[] {
  return db.select().from(tasks).where(eq(tasks.status, "gate_queued")).all();
}

/**
 * Fields a user may change while a task has not started yet.
 *
 * `requireHumanCodeReview` is here rather than on a started task because
 * flipping it mid-flight would either skip a gate the task already passed or
 * insert one it already went by.
 */
export type EditableTaskFields = {
  repoId: string;
  title: string;
  description: string;
  priority: Priority;
  requireHumanCodeReview: boolean;
  dependsOn: string[];
  maxCostUsd: number | null;
};

export function updateTaskFields(id: string, fields: EditableTaskFields): TaskRow | null {
  const { dependsOn, ...taskColumns } = fields;
  return db.transaction(() => {
    const updated = updateTask(id, taskColumns);
    replaceDependencies(id, dependsOn);
    return updated;
  });
}

/**
 * Hard-deletes a task. Every child table cascades from `tasks`, so one statement
 * is enough — see `spec-task-queue.md` §7.2.
 */
export function deleteTask(id: string): boolean {
  const removed = db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id }).all();
  return removed.length > 0;
}

export function updateTask(id: string, patch: Partial<TaskRow>): TaskRow | null {
  return (
    db
      .update(tasks)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get() ?? null
  );
}

/**
 * Sets `updated_at` to an exact, caller-chosen value rather than `Date.now()`
 * — the one operation {@link updateTask} cannot express, since it always
 * stamps the current time over whatever the patch says. Used by
 * `bumpToFrontOfQueue` (`spec-board-at-scale.md` §8.3), which needs
 * `updated_at` set *older* than every other queued task's, not newer.
 */
export function setTaskUpdatedAt(id: string, updatedAt: number): void {
  db.update(tasks).set({ updatedAt }).where(eq(tasks.id, id)).run();
}

/** Moves a task to a new stage and derives its board status. */
export function setTaskStage(
  id: string,
  stage: Stage,
  extra: Partial<TaskRow> = {},
): TaskRow | null {
  return updateTask(id, { currentStage: stage, status: statusForStage(stage), ...extra });
}

export function setTaskEstimate(
  id: string,
  difficulty: Difficulty | null,
  criticality: Criticality | null,
): void {
  updateTask(id, { difficulty, criticality });
}

export function listStageRuns(taskId: string): StageRunRow[] {
  return db
    .select()
    .from(stageRuns)
    .where(eq(stageRuns.taskId, taskId))
    .orderBy(stageRuns.createdAt)
    .all();
}

export function getStageRun(id: string): StageRunRow | null {
  return db.select().from(stageRuns).where(eq(stageRuns.id, id)).get() ?? null;
}

/** The stage run for `stage`'s specific `attempt`, or `null` if it never ran. */
export function getStageRunByAttempt(
  taskId: string,
  stage: Stage,
  attempt: number,
): StageRunRow | null {
  return (
    db
      .select()
      .from(stageRuns)
      .where(and(eq(stageRuns.taskId, taskId), eq(stageRuns.stage, stage), eq(stageRuns.attempt, attempt)))
      .get() ?? null
  );
}

export function createStageRun(input: {
  taskId: string;
  stage: Stage;
  attempt: number;
  maxTurns?: number;
}): StageRunRow {
  return db
    .insert(stageRuns)
    .values({
      id: newId("run"),
      taskId: input.taskId,
      stage: input.stage,
      attempt: input.attempt,
      status: "pending",
      maxTurns: input.maxTurns,
    })
    .returning()
    .get();
}

export function updateStageRun(id: string, patch: Partial<StageRunRow>): void {
  db.update(stageRuns).set(patch).where(eq(stageRuns.id, id)).run();
}

export function markStageRunStatus(
  id: string,
  status: StageRunStatus,
  patch: Partial<StageRunRow> = {},
): void {
  const timestamps: Partial<StageRunRow> =
    status === "running" ? { startedAt: Date.now() } : { finishedAt: Date.now() };
  updateStageRun(id, { status, ...timestamps, ...patch });
}

/**
 * `stage_runs.started_at` of each task's currently-`running` stage run, keyed
 * by task id — one query for the whole board render rather than one per
 * card, for S1's "{stage label} · {elapsed}" meta line
 * (`spec-board-at-scale.md` §3.1). A task with no running stage run has no
 * entry. At most one `running` row exists per task at a time; if that were
 * ever violated the latest `startedAt` wins, since that is the run whose
 * elapsed time the card is actually claiming to show.
 */
export function activeStageRunStarts(): Map<string, number> {
  const rows = db
    .select({ taskId: stageRuns.taskId, startedAt: stageRuns.startedAt })
    .from(stageRuns)
    .where(eq(stageRuns.status, "running"))
    .all();

  const byTaskId = new Map<string, number>();
  for (const row of rows) {
    if (row.startedAt === null) continue;
    const existing = byTaskId.get(row.taskId);
    if (existing === undefined || row.startedAt > existing) byTaskId.set(row.taskId, row.startedAt);
  }
  return byTaskId;
}

/** How many DEVELOPMENT runs the task has had; drives the QA rework counter. */
export function countStageRuns(taskId: string, stage: Stage): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(stageRuns)
    .where(and(eq(stageRuns.taskId, taskId), eq(stageRuns.stage, stage)))
    .get();
  return row?.count ?? 0;
}

export function saveArtifact(input: {
  taskId: string;
  stageRunId: string;
  type: ArtifactType;
  contentMd: string;
}): ArtifactRow {
  return db
    .insert(artifacts)
    .values({
      id: newId("art"),
      taskId: input.taskId,
      stageRunId: input.stageRunId,
      type: input.type,
      contentMd: input.contentMd,
      // Explicit, millisecond-resolution `Date.now()` rather than the column's
      // `unixepoch() * 1000` default, which is only second-resolution — SQLite's
      // `unixepoch()` truncates to whole seconds regardless of the `* 1000`.
      // `latestArtifactSince` compares this column against a `Date.now()`-sourced
      // `sinceMs`, so both sides need real millisecond precision or an artifact
      // saved within the same wall-clock second as the cycle boundary could be
      // wrongly excluded as stale.
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

/** Latest version of one artifact type for a task. */
export function latestArtifact(taskId: string, type: ArtifactType): ArtifactRow | null {
  return (
    db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.taskId, taskId), eq(artifacts.type, type)))
      .orderBy(desc(artifacts.createdAt))
      .limit(1)
      .get() ?? null
  );
}

/**
 * Latest artifact of `type` produced at or after `sinceMs`.
 *
 * Used by `gatherInputs` to keep a stale reviewer report out of a Developer
 * rework prompt: with `VERIFICATION` ahead of `CODE_REVIEW`, a red
 * verification can send work back to the Developer before any reviewer ran
 * in that cycle, and `latestArtifact` alone would still find the *previous*
 * cycle's (already-approved) report. `sinceMs` is the previous `DEVELOPMENT`
 * run's finish time, so anything from before that is excluded rather than
 * handed to the model with a caveat it may not read.
 */
export function latestArtifactSince(
  taskId: string,
  type: ArtifactType,
  sinceMs: number,
): ArtifactRow | null {
  return (
    db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.taskId, taskId),
          eq(artifacts.type, type),
          sql`${artifacts.createdAt} >= ${sinceMs}`,
        ),
      )
      .orderBy(desc(artifacts.createdAt))
      .limit(1)
      .get() ?? null
  );
}

/** Every artifact produced by one stage run, oldest first — for the run detail page. */
export function listArtifactsForStageRun(stageRunId: string): ArtifactRow[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.stageRunId, stageRunId))
    .orderBy(artifacts.createdAt)
    .all();
}

/** Latest version of every artifact type produced so far, in pipeline order. */
export function listLatestArtifacts(taskId: string): ArtifactRow[] {
  const all = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(artifacts.createdAt)
    .all();

  const byType = new Map<string, ArtifactRow>();
  for (const artifact of all) byType.set(artifact.type, artifact);
  return [...byType.values()];
}

/**
 * Every version of one artifact type, newest first — the rework history
 * `listLatestArtifacts` collapses away. See spec-audit-trail.md §7.
 */
export function listArtifacts(taskId: string, type: ArtifactType): ArtifactRow[] {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.type, type)))
    .orderBy(desc(artifacts.createdAt))
    .all();
}

/** One artifact's version metadata, without loading its body. */
export type ArtifactVersion = {
  id: string;
  type: ArtifactType;
  stageRunId: string;
  attempt: number;
  createdAt: number;
  sizeBytes: number;
};

/**
 * Every artifact's version metadata for a task, newest first — for a version
 * switcher that must not load ~120 KB of Markdown bodies just to render a
 * list of versions. Joins `stage_runs` for `attempt` and selects
 * `length(content_md)` rather than the column itself.
 */
export function listArtifactVersions(taskId: string): ArtifactVersion[] {
  return db
    .select({
      id: artifacts.id,
      type: artifacts.type,
      stageRunId: artifacts.stageRunId,
      attempt: stageRuns.attempt,
      createdAt: artifacts.createdAt,
      sizeBytes: sql<number>`length(${artifacts.contentMd})`,
    })
    .from(artifacts)
    .innerJoin(stageRuns, eq(artifacts.stageRunId, stageRuns.id))
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt))
    .all();
}

/**
 * Every artifact version for a task, with its body and producing attempt —
 * the export's source of truth: `listLatestArtifacts` collapses rework
 * history away, and the export is the one place that must not (§9).
 */
export function listAllArtifacts(taskId: string): Array<ArtifactRow & { attempt: number }> {
  return db
    .select({
      id: artifacts.id,
      taskId: artifacts.taskId,
      stageRunId: artifacts.stageRunId,
      type: artifacts.type,
      contentMd: artifacts.contentMd,
      createdAt: artifacts.createdAt,
      attempt: stageRuns.attempt,
    })
    .from(artifacts)
    .innerJoin(stageRuns, eq(artifacts.stageRunId, stageRuns.id))
    .where(eq(artifacts.taskId, taskId))
    .orderBy(artifacts.createdAt)
    .all();
}

/** One artifact's full body, scoped to `taskId` so a foreign id cannot match. */
export function getArtifact(taskId: string, artifactId: string): ArtifactRow | null {
  return (
    db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.taskId, taskId)))
      .get() ?? null
  );
}

/**
 * Persists one row per verification command result — the audit record, and
 * what the gate badge and the PR renderer read (see `verification.ts`'s
 * `CommandResult`). A no-op on an empty list, which is the `skipped` case.
 */
export function saveVerificationRuns(
  taskId: string,
  stageRunId: string,
  results: CommandResult[],
): void {
  if (results.length === 0) return;
  db.insert(verificationRuns)
    .values(
      results.map((result) => ({
        id: newId("ver"),
        taskId,
        stageRunId,
        kind: result.kind,
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
      })),
    )
    .run();
}

/**
 * Verification rows for a task, oldest first. Reads outlive the workspace —
 * the whole point, since the clone is deleted on retention but the record of
 * what passed is what the pull request refers to.
 */
export function listVerificationRuns(taskId: string, stageRunId?: string): VerificationRunRow[] {
  return db
    .select()
    .from(verificationRuns)
    .where(
      stageRunId
        ? and(eq(verificationRuns.taskId, taskId), eq(verificationRuns.stageRunId, stageRunId))
        : eq(verificationRuns.taskId, taskId),
    )
    .orderBy(verificationRuns.createdAt)
    .all();
}

/**
 * Byte cap on a stored transcript, regardless of the retention setting — see
 * spec-audit-trail.md §11. A `DEVELOPMENT` run with a generous `maxTurns`
 * reading and writing source files is otherwise unbounded.
 */
export const MAX_TRANSCRIPT_BYTES = 8_000_000;

/**
 * Drops elements from the middle of an over-sized transcript array, keeping
 * as much of the head and the tail as fits — the setup and the outcome are
 * the informative ends. Leaves the result a valid JSON array rather than
 * truncating the serialised string mid-element.
 */
function capTranscript(transcript: unknown): { transcript: unknown; truncated: boolean } {
  if (!Array.isArray(transcript)) return { transcript, truncated: false };
  if (Buffer.byteLength(JSON.stringify(transcript), "utf8") <= MAX_TRANSCRIPT_BYTES) {
    return { transcript, truncated: false };
  }

  const marker = { truncated: true, reason: "transcript exceeded MAX_TRANSCRIPT_BYTES; middle entries dropped" };
  let budget = MAX_TRANSCRIPT_BYTES - Buffer.byteLength(JSON.stringify(marker), "utf8");
  const head: unknown[] = [];
  const tail: unknown[] = [];
  let i = 0;
  let j = transcript.length - 1;
  let fromHead = true;

  while (i <= j && budget > 0) {
    const candidate = fromHead ? transcript[i] : transcript[j];
    const size = Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1; // +1 for the array comma
    if (size > budget) break;
    if (fromHead) {
      head.push(candidate);
      i++;
    } else {
      tail.unshift(candidate);
      j--;
    }
    budget -= size;
    fromHead = !fromHead;
  }

  return { transcript: [...head, marker, ...tail], truncated: true };
}

export function saveTranscript(input: {
  stageRunId: string;
  sessionId: string | null;
  transcript: unknown;
}): void {
  const { transcript: capped } = capTranscript(input.transcript);
  const { text: redacted } = redactSecrets(JSON.stringify(capped));

  db.insert(agentRuns)
    .values({
      id: newId("agent"),
      stageRunId: input.stageRunId,
      sessionId: input.sessionId,
      transcriptJson: redacted,
    })
    .run();
}

/** Every `agent_runs` row for one stage run, oldest first — see §12.5: a
 * retried job can leave more than one row behind, so a reader must pick the
 * newest rather than assume a single `.get()`. */
export function listAgentRunsByStageRun(stageRunId: string): AgentRunRow[] {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.stageRunId, stageRunId))
    .orderBy(agentRuns.createdAt)
    .all();
}

/** The newest `agent_runs` row for one stage run, or `null` if it never had one. */
export function latestAgentRun(stageRunId: string): AgentRunRow | null {
  return (
    db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.stageRunId, stageRunId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1)
      .get() ?? null
  );
}

/**
 * Replaces `transcript_json` with a tombstone (`{"pruned":true,"prunedAt":…}`)
 * for every `agent_runs` row older than `cutoffMs` — the retention sweep,
 * spec-audit-trail.md §11. The row is never deleted: a deleted row would be
 * indistinguishable from a stage that never had a transcript at all (a
 * `DELIVERY` run, or one that failed before the provider returned).
 *
 * `session_id` and the `stage_runs` prompt columns are untouched — the
 * prompt is the smaller half of the record and the half that answers "what
 * was this run given", so it is never pruned regardless of this setting.
 *
 * The `NOT LIKE` guard makes a second sweep over the same data a no-op: an
 * already-tombstoned row's `transcript_json` starts with `{"pruned":true`,
 * so it is excluded rather than re-tombstoned.
 */
export function sweepTranscriptRetention(cutoffMs: number): number {
  const tombstone = JSON.stringify({ pruned: true, prunedAt: Date.now() });
  const result = db
    .update(agentRuns)
    .set({ transcriptJson: tombstone })
    .where(
      and(
        sql`${agentRuns.createdAt} < ${cutoffMs}`,
        sql`${agentRuns.transcriptJson} NOT LIKE '{"pruned":true%'`,
      ),
    )
    .run();
  return result.changes;
}

export type TranscriptStorageStats = { count: number; totalBytes: number };

/** `count(*)` and `sum(length(transcript_json))` over `agent_runs` — the Settings screen's storage readout. */
export function transcriptStorageStats(): TranscriptStorageStats {
  const row = db
    .select({
      count: sql<number>`count(*)`,
      totalBytes: sql<number>`coalesce(sum(length(${agentRuns.transcriptJson})), 0)`,
    })
    .from(agentRuns)
    .get();
  return { count: row?.count ?? 0, totalBytes: row?.totalBytes ?? 0 };
}

export function listApprovals(taskId: string): ApprovalRow[] {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.taskId, taskId))
    .orderBy(approvals.decidedAt)
    .all();
}

export function recordApproval(input: {
  taskId: string;
  gate: Gate;
  decision: GateDecision;
  comment?: string;
}): ApprovalRow {
  return db
    .insert(approvals)
    .values({
      id: newId("appr"),
      taskId: input.taskId,
      gate: input.gate,
      decision: input.decision,
      comment: input.comment,
    })
    .returning()
    .get();
}

export type UsageByStage = {
  stage: Stage;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/**
 * Aggregated token/cost figures per stage, optionally scoped to one task and/or
 * a rolling window.
 *
 * `windowDays` mirrors `costPerTask`'s cutoff-computed-inside pattern (its
 * own comment explains why); omitted, this behaves exactly as it always has —
 * every stage run, regardless of age. See stories.md S1: this used to take no
 * window at all, which is why the Costs page hardcoded "(all time)" beside a
 * selector that only affected the by-task table.
 */
export function usageByStage(taskId?: string, windowDays?: number): UsageByStage[] {
  const since =
    windowDays && Number.isFinite(windowDays) ? Date.now() - windowDays * 86_400_000 : undefined;

  const conditions = [
    taskId ? eq(stageRuns.taskId, taskId) : undefined,
    since ? sql`${stageRuns.createdAt} >= ${since}` : undefined,
  ].filter((condition) => condition !== undefined);

  return db
    .select({
      stage: stageRuns.stage,
      runs: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${stageRuns.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${stageRuns.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
    })
    .from(stageRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(stageRuns.stage)
    .all();
}

export function totalCostForTask(taskId: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)` })
    .from(stageRuns)
    .where(eq(stageRuns.taskId, taskId))
    .get();
  return row?.total ?? 0;
}

/**
 * {@link totalCostForTask}, for every task at once via one `GROUP BY` —
 * the board's aggregate render collapses what used to be one query per task
 * into this single one (`spec-board-at-scale.md` §9.1). A task with no
 * stage runs has no entry; callers default it to `0`, matching
 * `totalCostForTask`'s own zero result.
 */
export function costByTaskId(): Map<string, number> {
  const rows = db
    .select({
      taskId: stageRuns.taskId,
      total: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
    })
    .from(stageRuns)
    .groupBy(stageRuns.taskId)
    .all();
  return new Map(rows.map((row) => [row.taskId, row.total]));
}

/**
 * Total cost across every task for stage runs that started at or after
 * `sinceMs`, falling back to `created_at` for a run that never reached
 * `running` (so a pending/failed-to-start run is not silently excluded from
 * "today's spend").
 *
 * `provider`, when given, scopes the sum to one LLM backend — see
 * stories.md S2. `stage_runs.provider` predates this filter and was never
 * backfilled (§4.2 of the brief), so a `NULL` row is a run whose provenance
 * simply was not recorded yet, not evidence it was any particular provider.
 * `"claude"` includes those `NULL` rows anyway, for continuity with the
 * pre-multi-provider period when every run genuinely was Claude; `"chatgpt"`
 * and `"gemini"` exclude them, since attributing an unknown run to either
 * would be a guess this codebase otherwise refuses to make (see `schema.ts`'s
 * `repos.provider` comment on the same tradeoff going the other way).
 */
export function costSince(sinceMs: number, provider?: LlmProviderId): number {
  const conditions = [sql`coalesce(${stageRuns.startedAt}, ${stageRuns.createdAt}) >= ${sinceMs}`];
  if (provider === "claude") {
    conditions.push(sql`(${stageRuns.provider} = ${provider} OR ${stageRuns.provider} IS NULL)`);
  } else if (provider) {
    conditions.push(eq(stageRuns.provider, provider));
  }

  const row = db
    .select({
      total: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
    })
    .from(stageRuns)
    .where(and(...conditions))
    .get();
  return row?.total ?? 0;
}

export type TaskCostSummary = {
  taskId: string;
  title: string;
  status: string;
  createdAt: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * `true` when at least one stage run contributing to this task's totals was
   * written before the cache-token accounting fix (stories.md S1) landed on
   * this installation — its `inputTokens` (and this task's total) may still be
   * understated. See `cacheTokenFixAppliedAt`'s comment for why this is a
   * per-install cutoff rather than a per-row marker.
   */
  hasUnderReportedTokens: boolean;
};

/**
 * Cost per task, optionally limited to a rolling window.
 *
 * The cutoff is computed here rather than by the caller so React components can
 * request "the last 30 days" without reading the clock during render.
 */
export function costPerTask(windowDays?: number): TaskCostSummary[] {
  const since =
    windowDays && Number.isFinite(windowDays)
      ? Date.now() - windowDays * 86_400_000
      : undefined;

  // No cutoff row (a database that has somehow never run the fix's migration)
  // is treated as "every row predates it" — the safe default, matching
  // `cacheTokenFixAppliedAt`'s own contract.
  const fixCutoff = cacheTokenFixAppliedAt() ?? Number.POSITIVE_INFINITY;

  const rows = db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      status: tasks.status,
      createdAt: tasks.createdAt,
      costUsd: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${stageRuns.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${stageRuns.outputTokens}), 0)`,
      hasUnderReportedTokens: sql<number>`
        exists (
          select 1 from ${stageRuns}
           where ${stageRuns.taskId} = ${tasks.id}
             and ${stageRuns.createdAt} < ${fixCutoff}
        )`,
    })
    .from(tasks)
    .leftJoin(stageRuns, eq(stageRuns.taskId, tasks.id))
    .where(since ? sql`${tasks.createdAt} >= ${since}` : undefined)
    .groupBy(tasks.id)
    .orderBy(desc(tasks.createdAt))
    .all();

  return rows.map((row) => ({ ...row, hasUnderReportedTokens: Boolean(row.hasUnderReportedTokens) }));
}

/** Optional filter shared by `stageRunExport` and `dailySpend` — see stories.md S5. */
export type UsageExportFilter = { days?: number; taskId?: string };

/** Resolves `filter.days` into the same cutoff `costPerTask` computes, or `undefined` for "all time". */
function windowCutoff(days?: number): number | undefined {
  return days && Number.isFinite(days) ? Date.now() - days * 86_400_000 : undefined;
}

export type StageRunExportRow = {
  taskId: string;
  taskTitle: string;
  repo: string;
  stage: Stage;
  attempt: number;
  provider: LlmProviderId | null;
  model: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  status: StageRunStatus;
};

/**
 * One row per `stage_runs` row — including `failed` and `cancelled` ones —
 * for the CSV export. The grain someone reconciling against a provider
 * invoice actually needs, unlike the by-stage/by-task aggregates above.
 *
 * Filtered by the task's `createdAt`, the same column `costPerTask` filters
 * on, so a given `days` produces the same task set the Costs page's by-task
 * table shows — the export and the page must not silently disagree about
 * what "the last N days" means (see stories.md S1's whole point).
 */
export function stageRunExport(filter: UsageExportFilter = {}): StageRunExportRow[] {
  const since = windowCutoff(filter.days);
  const conditions = [
    filter.taskId ? eq(stageRuns.taskId, filter.taskId) : undefined,
    since ? sql`${tasks.createdAt} >= ${since}` : undefined,
  ].filter((condition) => condition !== undefined);

  return db
    .select({
      taskId: tasks.id,
      taskTitle: tasks.title,
      repo: repos.name,
      stage: stageRuns.stage,
      attempt: stageRuns.attempt,
      provider: stageRuns.provider,
      model: stageRuns.model,
      startedAt: stageRuns.startedAt,
      finishedAt: stageRuns.finishedAt,
      inputTokens: stageRuns.inputTokens,
      cacheReadTokens: stageRuns.cacheReadTokens,
      cacheWriteTokens: stageRuns.cacheWriteTokens,
      outputTokens: stageRuns.outputTokens,
      costUsd: stageRuns.costUsd,
      status: stageRuns.status,
    })
    .from(stageRuns)
    .innerJoin(tasks, eq(stageRuns.taskId, tasks.id))
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(stageRuns.createdAt)
    .all();
}

export type DailySpend = { date: string; costUsd: number };

/**
 * Spend bucketed by local calendar day — the daily series above the Costs
 * page's tables (stories.md S8.2/S5). `date(...)`'s `'localtime'` modifier
 * matters and mirrors `quota.ts`'s deliberate choice of local midnight: a
 * chart bucketed by UTC beside a quota bar reset at local midnight would
 * disagree by up to a day at the boundary.
 */
export function dailySpend(filter: UsageExportFilter = {}): DailySpend[] {
  const since = windowCutoff(filter.days);
  const bucket = sql<string>`date(coalesce(${stageRuns.startedAt}, ${stageRuns.createdAt}) / 1000, 'unixepoch', 'localtime')`;
  const conditions = [
    filter.taskId ? eq(stageRuns.taskId, filter.taskId) : undefined,
    since ? sql`coalesce(${stageRuns.startedAt}, ${stageRuns.createdAt}) >= ${since}` : undefined,
  ].filter((condition) => condition !== undefined);

  return db
    .select({
      date: bucket.as("date"),
      costUsd: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
    })
    .from(stageRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(bucket)
    .orderBy(bucket)
    .all();
}
