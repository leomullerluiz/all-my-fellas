import Link from "next/link";
import { notFound } from "next/navigation";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { LiveLog } from "@/components/live-log";
import { RunStatusBadge, StageBadge, StatusBadge } from "@/components/stage-badge";
import { GatePanel, TaskControls } from "@/components/task-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCost, formatDateTime, formatDuration, formatTokens } from "@/lib/utils";
import { STAGE_LABELS, isGate } from "@/server/pipeline/stages";
import {
  getTaskWithRepo,
  listApprovals,
  listLatestArtifacts,
  listStageRuns,
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
  const approvals = listApprovals(id);
  const cost = totalCostForTask(id);
  const live = ["queued", "running", "awaiting_gate"].includes(task.status);

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
          <TaskControls taskId={task.id} status={task.status} />
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
          {task.prUrl ? (
            <Link
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              Open pull request ↗
            </Link>
          ) : null}
        </div>

        {task.failureReason ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {task.failureReason}
          </div>
        ) : null}
      </header>

      {isGate(task.currentStage) ? (
        <GatePanel taskId={task.id} gate={task.currentStage} />
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
                        <span className="text-xs font-medium">{STAGE_LABELS[run.stage]}</span>
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
          <LiveLog taskId={task.id} live={live} />
          <ArtifactTabs artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}
