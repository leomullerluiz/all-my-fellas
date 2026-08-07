import { json, notFound, serverError } from "@/server/http/respond";
import { redactSecrets } from "@/server/pipeline/audit/redact";
import { type NormalizedTranscript, normalizeTranscript } from "@/server/pipeline/audit/normalize";
import type { LlmProviderId } from "@/server/config/llm-providers";
import { type AgentRunRow, type StageRunRow } from "@/server/db/schema";
import { getStageRun, latestAgentRun } from "@/server/tasks/service";

type Params = { id: string; runId: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** A tombstone written by the retention sweep (§11): `{"pruned":true,...}`. */
type Tombstone = { pruned: true; prunedAt: number; originalBytes?: number };

function isTombstone(value: unknown): value is Tombstone {
  return typeof value === "object" && value !== null && (value as { pruned?: unknown }).pruned === true;
}

/**
 * Parses and normalises one agent run's transcript, memoised on `(id,
 * length(transcript_json))` — a tombstoned row's length changes, which is
 * exactly the invalidation this key needs and no more. See §6.1.
 */
const transcriptCache = new Map<string, NormalizedTranscript | { pruned: true; prunedAt: number }>();

function normalizedFor(run: AgentRunRow, provider: LlmProviderId | null): NormalizedTranscript | { pruned: true; prunedAt: number } {
  const key = `${run.id}:${run.transcriptJson.length}`;
  const cached = transcriptCache.get(key);
  if (cached) return cached;

  const { text: redacted } = redactSecrets(run.transcriptJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted);
  } catch {
    parsed = [];
  }

  const result: NormalizedTranscript | { pruned: true; prunedAt: number } = isTombstone(parsed)
    ? { pruned: true, prunedAt: parsed.prunedAt }
    : normalizeTranscript(provider, parsed);

  transcriptCache.set(key, result);
  return result;
}

/**
 * `GET /api/tasks/:taskId/runs/:runId/transcript?offset=&limit=` — the stage
 * run's prompt and a paginated, normalised transcript.
 *
 * Scoped to `taskId`: a `runId` belonging to another task is a 404, the same
 * shape `deleteAttachment` uses to make a foreign id un-matchable — otherwise
 * run ids are guessable identifiers into an unscoped table.
 */
export async function GET(request: Request, context: { params: Promise<Params> }) {
  try {
    const { id, runId } = await context.params;

    const run: StageRunRow | null = getStageRun(runId);
    if (!run || run.taskId !== id) return notFound(`Run ${runId} not found.`);

    const url = new URL(request.url);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT),
    );

    const provider = run.provider;
    const agentRun = latestAgentRun(runId);

    const systemPrompt = run.systemPrompt !== null ? redactSecrets(run.systemPrompt).text : null;
    const userPrompt = run.userPrompt !== null ? redactSecrets(run.userPrompt).text : null;

    const base = {
      stageRun: {
        id: run.id,
        stage: run.stage,
        attempt: run.attempt,
        model: run.model,
        provider: run.provider,
        status: run.status,
        costUsd: run.costUsd,
        error: run.error,
      },
      prompt: { system: systemPrompt, user: userPrompt },
    };

    if (!agentRun) {
      return json({
        ...base,
        transcript: { available: false, reason: "no_transcript" as const },
      });
    }

    const normalized = normalizedFor(agentRun, provider);

    if ("pruned" in normalized) {
      return json({
        ...base,
        transcript: { available: false, reason: "pruned" as const, prunedAt: normalized.prunedAt },
      });
    }

    const total = normalized.entries.length;
    const entries = normalized.entries.slice(offset, offset + limit);

    return json({
      ...base,
      transcript: {
        available: true,
        provider: normalized.provider,
        truncated: normalized.truncated,
        total,
        offset,
        limit,
        entries,
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
