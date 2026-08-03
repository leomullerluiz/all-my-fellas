import Link from "next/link";
import { notFound } from "next/navigation";

import { DiffViewer } from "@/components/diff-viewer";
import { GatePanel } from "@/components/task-actions";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { getTaskWithRepo, latestArtifact } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

/**
 * The review screen: the diff, the agent's code review report, and the decision
 * controls on one page, so a reviewer does not have to hold two tabs open.
 */
export default async function ReviewPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  const task = getTaskWithRepo(id);
  if (!task) notFound();

  const report = latestArtifact(id, "code_review_report");
  const atGate = task.currentStage === "HUMAN_CODE_REVIEW";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href={`/tasks/${id}`}
          className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          ← Back to the task
        </Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{task.title}</h1>
        <p className="mt-1 text-xs text-muted">
          {task.repo.name}
          {task.branchName ? ` · ${task.branchName}` : ""}
        </p>
      </div>

      {atGate ? <GatePanel taskId={task.id} gate="HUMAN_CODE_REVIEW" /> : null}

      <DiffViewer taskId={task.id} />

      {report ? (
        <Card>
          <CardHeader>
            <CardTitle>What the Code Reviewer found</CardTitle>
          </CardHeader>
          <CardBody>
            <pre className="artifact-body max-h-[28rem] overflow-auto">{report.contentMd}</pre>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
