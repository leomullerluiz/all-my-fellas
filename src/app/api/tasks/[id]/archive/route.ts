import { json, notFound, serverError } from "@/server/http/respond";
import { TaskNotFoundError, archiveTaskById } from "@/server/pipeline/orchestrator";

/**
 * `POST /api/tasks/:id/archive` — soft-deletes one task (S3 —
 * `spec-board-at-scale.md` §5). Safe on a task in any state; only its
 * visibility on the board, the list view and the dependency picker changes.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return json({ task: archiveTaskById(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    return serverError(error);
  }
}
