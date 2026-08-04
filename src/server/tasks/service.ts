import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client";
import { newId } from "../db/ids";
import {
  type ApprovalRow,
  type ArtifactRow,
  type AttachmentRow,
  type RepoRow,
  type StageRunRow,
  type TaskRow,
  agentRuns,
  approvals,
  artifacts,
  attachments,
  repos,
  stageRuns,
  tasks,
} from "../db/schema";
import { appendEvent } from "../events/store";
import type { ProviderId } from "../git/providers/types";
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
    })
    .returning()
    .get();
  return row;
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

export function listTasks(filter?: { status?: string }): TaskWithRepo[] {
  const rows = db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(filter?.status ? eq(tasks.status, filter.status as TaskRow["status"]) : undefined)
    .orderBy(desc(tasks.createdAt))
    .all();
  return rows.map((row) => ({ ...row.task, repo: row.repo }));
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
        status: "queued",
        currentStage: "CREATED",
      })
      .returning()
      .get();

    if (input.attachments && input.attachments.length > 0) {
      insertAttachments(created.id, input.attachments);
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

/** Removes one attachment, scoped to `taskId` so a foreign id cannot match. */
export function deleteAttachment(taskId: string, attachmentId: string): boolean {
  const removed = db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.taskId, taskId)))
    .returning({ id: attachments.id })
    .all();
  return removed.length > 0;
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
};

export function updateTaskFields(id: string, fields: EditableTaskFields): TaskRow | null {
  return updateTask(id, fields);
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

export function saveTranscript(input: {
  stageRunId: string;
  sessionId: string | null;
  transcript: unknown;
}): void {
  db.insert(agentRuns)
    .values({
      id: newId("agent"),
      stageRunId: input.stageRunId,
      sessionId: input.sessionId,
      transcriptJson: JSON.stringify(input.transcript),
    })
    .run();
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

export function usageByStage(taskId?: string): UsageByStage[] {
  return db
    .select({
      stage: stageRuns.stage,
      runs: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${stageRuns.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${stageRuns.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
    })
    .from(stageRuns)
    .where(taskId ? eq(stageRuns.taskId, taskId) : undefined)
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

export type TaskCostSummary = {
  taskId: string;
  title: string;
  status: string;
  createdAt: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
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

  return db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      status: tasks.status,
      createdAt: tasks.createdAt,
      costUsd: sql<number>`coalesce(sum(${stageRuns.costUsd}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${stageRuns.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${stageRuns.outputTokens}), 0)`,
    })
    .from(tasks)
    .leftJoin(stageRuns, eq(stageRuns.taskId, tasks.id))
    .where(since ? sql`${tasks.createdAt} >= ${since}` : undefined)
    .groupBy(tasks.id)
    .orderBy(desc(tasks.createdAt))
    .all();
}
