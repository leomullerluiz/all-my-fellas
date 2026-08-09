import { json, notFound, serverError } from "@/server/http/respond";
import { TaskNotFoundError, resumeTask } from "@/server/pipeline/orchestrator";
import { getTask } from "@/server/tasks/service";

/**
 * `POST /api/tasks/:id/resume` — clears a pause and schedules whatever stage
 * was withheld by it, if any (§9.2).
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    resumeTask(id);
    return json({ task: getTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    return serverError(error);
  }
}
