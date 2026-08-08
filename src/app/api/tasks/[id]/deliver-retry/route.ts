import { conflict, json, notFound, serverError } from "@/server/http/respond";
import { ChangeRequestNotRetryableError, retryPullRequestCreation } from "@/server/pipeline/execute";
import { TaskNotFoundError } from "@/server/pipeline/orchestrator";
import { getTaskWithRepo } from "@/server/tasks/service";

/**
 * `POST /api/tasks/:id/deliver-retry` — "Try again" on a manual delivery
 * outcome. Re-runs only the change-request call against the branch a
 * previous `DELIVERY` run already pushed — see stories.md S1.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await retryPullRequestCreation(id);
    const task = getTaskWithRepo(id);
    return json({ task });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof ChangeRequestNotRetryableError) return conflict(error.message);
    return serverError(error);
  }
}
