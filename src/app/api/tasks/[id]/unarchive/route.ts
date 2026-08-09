import { json, notFound, serverError } from "@/server/http/respond";
import { TaskNotFoundError, unarchiveTaskById } from "@/server/pipeline/orchestrator";

/** `POST /api/tasks/:id/unarchive` — restores an archived task (S3). */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return json({ task: unarchiveTaskById(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    return serverError(error);
  }
}
