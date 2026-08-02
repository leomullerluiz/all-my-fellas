import { conflict, json, notFound, serverError } from "@/server/http/respond";
import { GateError, TaskNotFoundError, retryTask } from "@/server/pipeline/orchestrator";

/** `POST /api/tasks/:id/retry` — re-runs the stage the task failed on. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return json({ transition: retryTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
