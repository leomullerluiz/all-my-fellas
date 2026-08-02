import { json, notFound, serverError } from "@/server/http/respond";
import {
  listApprovals,
  listLatestArtifacts,
  listStageRuns,
  getTaskWithRepo,
  totalCostForTask,
} from "@/server/tasks/service";

/** `GET /api/tasks/:id` — full detail: stage, artifacts, runs, cost, PR. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const task = getTaskWithRepo(id);
    if (!task) return notFound(`Task ${id} not found.`);

    return json({
      task,
      stageRuns: listStageRuns(id),
      artifacts: listLatestArtifacts(id),
      approvals: listApprovals(id),
      costUsd: totalCostForTask(id),
    });
  } catch (error) {
    return serverError(error);
  }
}
