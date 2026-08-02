import {
  badRequest,
  conflict,
  json,
  notFound,
  parseBody,
  serverError,
} from "@/server/http/respond";
import {
  GateError,
  TaskNotFoundError,
  deleteCreatedTask,
  editTask,
} from "@/server/pipeline/orchestrator";
import {
  getRepo,
  getTask,
  getTaskWithRepo,
  listApprovals,
  listLatestArtifacts,
  listStageRuns,
  totalCostForTask,
} from "@/server/tasks/service";
import { updateTaskSchema } from "@/server/validation/schemas";

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

/**
 * `PATCH /api/tasks/:id` — edits a task that has not started.
 *
 * The stage is re-read server-side: a disabled control on a stale board is a
 * hint, not a guarantee.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    const parsed = await parseBody(request, updateTaskSchema);
    if (!parsed.ok) return parsed.response;

    if (!getRepo(parsed.data.repoId)) {
      return badRequest("That repository connection no longer exists.");
    }

    editTask(id, parsed.data);
    return json({ task: getTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}

/** `DELETE /api/tasks/:id` — removes a task that has not started. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    deleteCreatedTask(id);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
