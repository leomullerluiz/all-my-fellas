import { json, notFound, serverError } from "@/server/http/respond";
import { TaskNotFoundError, bumpToFrontOfQueue } from "@/server/pipeline/orchestrator";
import { getTask } from "@/server/tasks/service";

/**
 * `POST /api/tasks/:id/run-next` — "Run this next" on a queued card's menu
 * (S7 — `spec-board-at-scale.md` §8.3). A no-op, not an error, when the task
 * is no longer queued — see `bumpToFrontOfQueue`'s docblock.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    bumpToFrontOfQueue(id);
    return json({ task: getTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    return serverError(error);
  }
}
