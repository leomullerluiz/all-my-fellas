import { json, notFound, serverError } from "@/server/http/respond";
import { TaskNotFoundError, cancelTask } from "@/server/pipeline/orchestrator";

/** `POST /api/tasks/:id/cancel` — stops a task that has not finished yet. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const transition = cancelTask(id);
    return json({ transition, alreadyFinished: transition === null });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    return serverError(error);
  }
}
