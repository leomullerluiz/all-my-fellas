import Link from "next/link";
import { notFound } from "next/navigation";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { ExecutionDot } from "@/components/execution-dot";
import { LiveLog } from "@/components/live-log";
import { RunStatusBadge, StageBadge, StatusBadge } from "@/components/stage-badge";
import { GatePanel, TaskControls } from "@/components/task-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { executionCopy } from "@/lib/execution-copy";
import { formatBytes, formatCost, formatDateTime, formatDuration, formatTokens } from "@/lib/utils";
import { readDiffIndex, summarizeDiff } from "@/server/git/diff";
import { providerFor } from "@/server/git/providers";
import { MAX_JOB_ATTEMPTS } from "@/server/jobs/queue";
import { executionStateFor, executionStates } from "@/server/pipeline/execution";
import { capacity, retryAvailability } from "@/server/pipeline/orchestrator";
import { STAGE_LABELS, isGate } from "@/server/pipeline/stages";
import { summarizeVerification } from "@/server/pipeline/verification-summary";
import {
  getTaskWithRepo,
  listApprovals,
  listArtifactVersions,
  listAttachments,
  listDependencies,
  listLatestArtifacts,
  listStageRuns,
  listVerificationRuns,
  totalCostForTask,
} from "@/server/tasks/service";

export const dynamic = "force-dynamic";

export default async function TaskDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;

  const task = getTaskWithRepo(id);
  if (!task) notFound();

  const runs = listStageRuns(id);
  const artifacts = listLatestArtifacts(id);
  const artifactVersions = listArtifactVersions(id);
  const approvals = listApprovals(id);
  const attachments = listAttachments(id);
  const dependsOn = listDependencies(id);
  const cost = totalCostForTask(id);
  const slots = capacity();
  // Computed by the same server function `GET /api/tasks/:id` calls, so the
  // rendered page and the API response can never disagree for this task.
  const retry = retryAvailability(id);
  const notStarted = task.currentStage === "CREATED";
  // Same derivation the board reads — computed once per render, not persisted.
  const execution = executionStateFor(id, executionStates());
  const executionState = executionCopy(execution, MAX_JOB_ATTEMPTS);
  // `gate_queued` has a recorded decision and no running stage — there is
  // nothing to reconnect to, so `LiveLog` should say "closed", not
  // "reconnecting" — see spec-execution-honesty.md §6.6. `awaiting_gate` is
  // kept on its own: another tab can still emit `gate_decided` for it.
  const live =
    execution.kind === "in_flight" ||
    execution.kind === "waiting_for_worker" ||
    execution.kind === "retry_backoff" ||
    task.status === "awaiting_gate";

  // Only read the workspace when a diff can actually exist; on the gate the
  // summary tells the reviewer how big the review is before they open it.
  let diffSummary: string | null = null;
  if (task.workspacePath && task.currentStage === "HUMAN_CODE_REVIEW") {
    try {
      diffSummary = summarizeDiff(
        await readDiffIndex(task.workspacePath, task.repo.defaultBranch),
      );
    } catch {
      // A missing or broken workspace must not take the whole page down.
      diffSummary = null;
    }
  }

  // Computed from `verification_runs`, not the workspace, so it survives
  // cleanup. `VERIFICATION` always precedes `HUMAN_CODE_REVIEW`, so a run
  // exists by the time the gate is reached.
  const latestVerificationRunId = runs.filter((run) => run.stage === "VERIFICATION").at(-1)?.id;
  const verificationSummary =
    task.currentStage === "HUMAN_CODE_REVIEW"
      ? summarizeVerification(
          latestVerificationRunId ? listVerificationRuns(task.id, latestVerificationRunId) : [],
        )
      : null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{task.title}</h1>
              <StatusBadge status={task.status} />
              <StageBadge stage={task.currentStage} />
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted">{task.id}</p>
          </div>
          <TaskControls
            taskId={task.id}
            taskTitle={task.title}
            status={task.status}
            notStarted={notStarted}
            capacity={slots}
            dependsOn={dependsOn}
            retry={retry}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone="neutral">{task.repo.name}</Badge>
          <Badge tone="neutral">priority {task.priority}</Badge>
          {task.difficulty ? <Badge tone="info">size {task.difficulty}</Badge> : null}
          {task.criticality ? (
            <Badge tone={task.criticality === "high" ? "danger" : "neutral"}>
              {task.criticality} risk
            </Badge>
          ) : null}
          <Badge tone="neutral">{formatCost(cost)}</Badge>
          {task.branchName ? (
            <span className="font-mono text-[11px]">{task.branchName}</span>
          ) : null}
          {task.requireHumanCodeReview ? (
            <Badge tone="warning">human code review</Badge>
          ) : null}
          {task.workspacePath ? (
            <Link
              href={`/tasks/${task.id}/review`}
              className="text-accent underline-offset-2 hover:underline"
            >
              View diff
            </Link>
          ) : null}
          {task.prUrl ? (
            <Link
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              {/* "merge request" on GitLab — the provider owns the wording. */}
              Open {providerFor(task.repo.provider).changeRequestNoun} ↗
            </Link>
          ) : null}
        </div>

        {/* Same wording/tone rules as the board — see `execution-copy.ts`.
            `idle` (not admitted, or admitted with nothing to report) renders
            nothing here; `StatusBadge`/`StageBadge` above already cover it. */}
        {executionState ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <ExecutionDot copy={executionState} />
            {executionState.description}
          </p>
        ) : null}

        {task.failureReason ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {task.failureReason}
          </div>
        ) : null}
      </header>

      {/* Gated on `status`, not `isGate(currentStage)`: a `gate_queued` task
          is still sitting on the gate stage, but its decision has already
          been recorded — re-offering the form would invite a second, stale
          decision. */}
      {task.status === "awaiting_gate" && isGate(task.currentStage) ? (
        <GatePanel
          taskId={task.id}
          gate={task.currentStage}
          // Only the two plain fields a client component can receive as
          // props — `RepositoryProvider` itself carries methods, which
          // cannot cross the server/client boundary.
          provider={{
            displayName: providerFor(task.repo.provider).displayName,
            changeRequestNoun: providerFor(task.repo.provider).changeRequestNoun,
          }}
          diffSummary={diffSummary}
          verification={verificationSummary}
        />
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardBody>
              {runs.length === 0 ? (
                <p className="text-xs text-muted">The first stage has not started yet.</p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {runs.map((run) => (
                    <li key={run.id} className="flex flex-col gap-1 border-l-2 border-border pl-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/tasks/${task.id}/runs/${run.id}`}
                          className="text-xs font-medium underline-offset-2 hover:underline"
                        >
                          {STAGE_LABELS[run.stage]}
                        </Link>
                        {run.attempt > 1 ? (
                          <Badge tone="warning">attempt {run.attempt}</Badge>
                        ) : null}
                        <RunStatusBadge status={run.status} />
                      </div>
                      <p className="text-[11px] text-muted">
                        {formatDuration(run.startedAt, run.finishedAt)} ·{" "}
                        {formatTokens(run.inputTokens)} in / {formatTokens(run.outputTokens)} out ·{" "}
                        {formatCost(run.costUsd)}
                      </p>
                      {run.error ? (
                        <p className="text-[11px] text-danger">{run.error}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>

          {dependsOn.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Prerequisites</CardTitle>
              </CardHeader>
              <CardBody>
                <ul className="flex flex-col gap-2">
                  {dependsOn.map((dependency) => (
                    <li
                      key={dependency.id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <Link
                        href={`/tasks/${dependency.id}`}
                        className="truncate text-accent underline-offset-2 hover:underline"
                      >
                        {dependency.title}
                      </Link>
                      <StatusBadge status={dependency.status} />
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Request</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">
                {task.description}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
            </CardHeader>
            <CardBody>
              {attachments.length === 0 ? (
                <p className="text-xs text-muted">No files attached to this task.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attachments.map((attachment) => (
                    <li key={attachment.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">{attachment.filename}</span>
                      <span className="flex shrink-0 items-center gap-2 text-muted">
                        <span>{formatBytes(attachment.sizeBytes)}</span>
                        <a
                          href={`/api/tasks/${task.id}/attachments/${attachment.id}`}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          Download
                        </a>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {approvals.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Approvals</CardTitle>
              </CardHeader>
              <CardBody>
                <ul className="flex flex-col gap-2">
                  {approvals.map((approval) => (
                    <li key={approval.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <Badge tone={approval.decision === "approve" ? "success" : "danger"}>
                          {approval.decision}
                        </Badge>
                        <span className="text-muted">{STAGE_LABELS[approval.gate]}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {formatDateTime(approval.decidedAt)}
                      </p>
                      {approval.comment ? (
                        <p className="mt-1 text-[11px]">{approval.comment}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          {/* A not-started task has nothing to stream, and an EventSource that
              polls every 700 ms for hours is pure waste — spec §10. */}
          {notStarted ? (
            <Card>
              <CardHeader>
                <CardTitle>Not started</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="text-xs text-muted">
                  This task is waiting in the queue. Nothing runs and nothing is spent until
                  you start it. You can still edit the description — that is what the
                  Stakeholder agent will receive.
                </p>
              </CardBody>
            </Card>
          ) : (
            <LiveLog taskId={task.id} live={live} />
          )}
          <ArtifactTabs artifacts={artifacts} taskId={task.id} versions={artifactVersions} />
        </div>
      </div>
    </div>
  );
}
