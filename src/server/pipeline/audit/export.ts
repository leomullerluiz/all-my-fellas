import type { LlmProviderId } from "../../config/llm-providers";
import type { AgentRunRow, ApprovalRow, StageRunRow } from "../../db/schema";
import { readEvents } from "../../events/store";
import {
  getTaskWithRepo,
  latestAgentRun,
  listAllArtifacts,
  listApprovals,
  listAttachments,
  listDependencies,
  listStageRuns,
} from "../../tasks/service";
import { type NormalizedTranscript, normalizeTranscript } from "./normalize";
import { PATTERN_COUNT, redactSecrets } from "./redact";

/**
 * One task's complete, self-contained record — spec-audit-trail.md §9.
 *
 * A single JSON object rather than a zip of Markdown files: the value here is
 * relational (which run produced which artifact, at which attempt, under
 * which prompt, at what cost), and a zip would flatten that into filenames.
 * Built entirely from the read queries §7's viewer already uses — this module
 * adds no new storage.
 */

export const EXPORT_FORMAT = "all-my-fellas/task-record";
export const EXPORT_VERSION = 1;

/** A tombstone written by the retention sweep (§11): `{"pruned":true,...}`. */
type Tombstone = { pruned: true; prunedAt: number };

function isTombstone(value: unknown): value is Tombstone {
  return typeof value === "object" && value !== null && (value as { pruned?: unknown }).pruned === true;
}

export type ExportedTranscript =
  | { available: false; provider: LlmProviderId | "unknown"; prunedAt?: number }
  | ({ available: true } & NormalizedTranscript);

export type ExportedStageRun = {
  id: string;
  stage: StageRunRow["stage"];
  attempt: number;
  status: StageRunRow["status"];
  model: string | null;
  provider: string | null;
  costUsd: number;
  error: string | null;
  prompt: { system: string | null; user: string | null };
  /** Omitted entirely when `includeTranscripts` is false. */
  transcript?: ExportedTranscript;
};

export type ExportedArtifact = {
  id: string;
  type: string;
  stageRunId: string;
  attempt: number;
  createdAt: number;
  contentMd: string;
};

export type TaskExport = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  redaction: { applied: true; patterns: number; hits: number };
  task: {
    id: string;
    title: string;
    description: string;
    status: string;
    difficulty: string | null;
    criticality: string | null;
    requireHumanCodeReview: boolean;
    prUrl: string | null;
    /** `'created'` | `'manual'` | `null` — what `prUrl` actually is. See stories.md S1. */
    deliveryOutcome: string | null;
  };
  repo: { name: string; provider: string; defaultBranch: string };
  stageRuns: ExportedStageRun[];
  artifacts: ExportedArtifact[];
  dependsOn: Array<{ id: string; title: string }>;
  approvals: ApprovalRow[];
  events: unknown[];
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: number;
    downloadPath: string;
  }>;
};

/** A running total of redaction hits, threaded through every field this module redacts. */
class HitCounter {
  hits = 0;

  redact(text: string): string {
    const result = redactSecrets(text);
    this.hits += result.hits;
    return result.text;
  }
}

function exportTranscript(
  run: StageRunRow,
  agentRun: AgentRunRow | null,
  tally: HitCounter,
): ExportedTranscript {
  const provider = (run.provider as LlmProviderId | null) ?? "unknown";
  if (!agentRun) return { available: false, provider };

  const redactedJson = tally.redact(agentRun.transcriptJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactedJson);
  } catch {
    parsed = [];
  }

  if (isTombstone(parsed)) {
    return { available: false, provider, prunedAt: parsed.prunedAt };
  }

  const normalized = normalizeTranscript(run.provider as LlmProviderId | null, parsed);
  return { available: true, ...normalized };
}

/**
 * Builds one task's complete record.
 *
 * @param includeTranscripts When false, every `stageRuns` item omits its
 *   `transcript` field entirely (prompts stay populated) and the agent-run
 *   table is never read — the point of `?transcripts=0` is to skip exactly
 *   that cost.
 */
export function buildTaskExport(taskId: string, options: { includeTranscripts?: boolean } = {}): TaskExport | null {
  const includeTranscripts = options.includeTranscripts ?? true;

  const task = getTaskWithRepo(taskId);
  if (!task) return null;

  const tally = new HitCounter();

  const stageRuns: ExportedStageRun[] = listStageRuns(taskId).map((run) => {
    const system = run.systemPrompt !== null ? tally.redact(run.systemPrompt) : null;
    const user = run.userPrompt !== null ? tally.redact(run.userPrompt) : null;

    const base: ExportedStageRun = {
      id: run.id,
      stage: run.stage,
      attempt: run.attempt,
      status: run.status,
      model: run.model,
      provider: run.provider,
      costUsd: run.costUsd,
      error: run.error,
      prompt: { system, user },
    };

    if (!includeTranscripts) return base;

    const agentRun = latestAgentRun(run.id);
    return { ...base, transcript: exportTranscript(run, agentRun, tally) };
  });

  const artifacts: ExportedArtifact[] = listAllArtifacts(taskId).map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    stageRunId: artifact.stageRunId,
    attempt: artifact.attempt,
    createdAt: artifact.createdAt,
    contentMd: artifact.contentMd,
  }));

  const attachments = listAttachments(taskId).map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt,
    downloadPath: `/api/tasks/${taskId}/attachments/${attachment.id}`,
  }));

  // `readEvents` defaults to a 500-row page for the SSE tail; the export wants
  // the whole log, so a generous limit stands in for "no limit".
  const events = readEvents(taskId, 0, Number.MAX_SAFE_INTEGER).map((event) => ({
    seq: event.seq,
    stageRunId: event.stageRunId,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  }));

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    redaction: { applied: true, patterns: PATTERN_COUNT, hits: tally.hits },
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      difficulty: task.difficulty,
      criticality: task.criticality,
      requireHumanCodeReview: task.requireHumanCodeReview,
      prUrl: task.prUrl,
      deliveryOutcome: task.deliveryOutcome,
    },
    // Explicitly the three fields the record needs — never `credentialRef`,
    // `credentialUsername` or `apiBaseUrl` (§9.1: a variable name is not a
    // secret, but it says nothing about why the task was built, and a base
    // URL can name an internal host).
    repo: { name: task.repo.name, provider: task.repo.provider, defaultBranch: task.repo.defaultBranch },
    stageRuns,
    artifacts,
    dependsOn: listDependencies(taskId).map((dependency) => ({ id: dependency.id, title: dependency.title })),
    approvals: listApprovals(taskId),
    events,
    attachments,
  };
}
