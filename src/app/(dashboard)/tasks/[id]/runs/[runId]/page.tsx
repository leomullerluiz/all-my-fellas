import Link from "next/link";
import { notFound } from "next/navigation";

import { TranscriptViewer } from "@/components/transcript-viewer";
import { RunStatusBadge } from "@/components/stage-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCost, formatDateTime, formatDuration, formatTokens } from "@/lib/utils";
import { STAGE_LABELS } from "@/server/pipeline/stages";
import { getStageRun, getTask, listArtifactsForStageRun } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

/**
 * A single stage run: what it was asked (both prompts, collapsed by default —
 * the user prompt is the longest thing on the page and the transcript is what
 * people came for), what it did (the paginated transcript), and what it
 * produced (this run's artifacts, plus the error when it failed).
 */
export default async function RunDetailPage(props: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await props.params;

  const task = getTask(id);
  if (!task) notFound();

  const run = getStageRun(runId);
  // Scoped to `id`: a run belonging to another task is a 404, not a 403 — the
  // same shape `deleteAttachment` already uses to make a foreign id
  // un-matchable. Otherwise run ids are guessable identifiers into an
  // unscoped table.
  if (!run || run.taskId !== id) notFound();

  const producedArtifacts = listArtifactsForStageRun(run.id);

  return (
    <div className="flex flex-col gap-5 px-6 py-6">
      <div className="flex flex-col gap-1">
        <Link href={`/tasks/${id}`} className="text-xs text-muted hover:underline">
          ← {task.title}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{STAGE_LABELS[run.stage]}</h1>
          {run.attempt > 1 ? <Badge tone="warning">attempt {run.attempt}</Badge> : null}
          <RunStatusBadge status={run.status} />
          {run.model ? <Badge tone="neutral">{run.model}</Badge> : null}
          {run.provider ? <Badge tone="neutral">{run.provider}</Badge> : null}
        </div>
        <p className="text-xs text-muted">
          {formatDuration(run.startedAt, run.finishedAt)} · {formatTokens(run.inputTokens)} in /{" "}
          {formatTokens(run.outputTokens)} out · {formatCost(run.costUsd)}
        </p>
        {run.error ? <p className="text-xs text-danger">{run.error}</p> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What it was asked</CardTitle>
        </CardHeader>
        <CardBody>
          {run.systemPrompt === null && run.userPrompt === null ? (
            <p className="text-xs text-muted">
              No prompt was recorded for this run — it predates prompt capture, or this stage
              never calls an LLM directly.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <details>
                <summary className="cursor-pointer text-xs font-medium">System prompt</summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                  {run.systemPrompt ?? "(none)"}
                </pre>
              </details>
              <details>
                <summary className="cursor-pointer text-xs font-medium">User prompt</summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                  {run.userPrompt ?? "(none)"}
                </pre>
              </details>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What it did</CardTitle>
        </CardHeader>
        <CardBody>
          <TranscriptViewer taskId={id} runId={run.id} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What it produced</CardTitle>
        </CardHeader>
        <CardBody>
          {producedArtifacts.length === 0 ? (
            <p className="text-xs text-muted">This run produced no artifact.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {producedArtifacts.map((artifact) => (
                <li key={artifact.id}>
                  <details>
                    <summary className="cursor-pointer text-xs font-medium">
                      {artifact.type} · {formatDateTime(artifact.createdAt)}
                    </summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                      {artifact.contentMd}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
