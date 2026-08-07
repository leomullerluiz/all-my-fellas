import { conflict, json, notFound, serverError } from "@/server/http/respond";
import { GateError, TaskNotFoundError, reopenTask } from "@/server/pipeline/orchestrator";

/**
 * `POST /api/tasks/:id/reopen` — moves a Not-delivered task (`REJECTED`,
 * `FAILED`, or `CANCELLED`) back to `CREATED` so it can be re-attempted.
 *
 * Distinct from `POST /api/tasks/:id/retry`, which re-runs the specific
 * stage a `failed` task stopped on in place; this route resets the task
 * entirely, the same way a freshly created task starts.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return json({ task: reopenTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
