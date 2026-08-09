import { json, notFound, serverError } from "@/server/http/respond";
import { TaskNotFoundError, pauseTask } from "@/server/pipeline/orchestrator";
import { getTask } from "@/server/tasks/service";

/**
 * `POST /api/tasks/:id/pause` — "finish the current stage, then wait" (§9.2).
 * Does not abort whatever is currently running; that remains Cancel's job.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    pauseTask(id);
    return json({ task: getTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    return serverError(error);
  }
}
