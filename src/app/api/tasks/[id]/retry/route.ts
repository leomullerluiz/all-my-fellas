import { conflict, json, notFound, serverError } from "@/server/http/respond";
import {
  CapacityError,
  NotRetryableError,
  TaskNotFoundError,
  retryTask,
} from "@/server/pipeline/orchestrator";

/**
 * `POST /api/tasks/:id/retry` — re-runs the stage the task failed on.
 *
 * A retry re-admits a terminal task, so it is capacity-checked exactly like a
 * fresh start — see `spec-task-queue.md` §8.3. Every refusal carries a `code`
 * (`spec-retry-recovery.md` §10.3) so a client that missed the disabled
 * button — a stale tab, a second window — can still branch on why.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return json({ transition: retryTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof CapacityError) return conflict(error.message, "capacity");
    if (error instanceof NotRetryableError) return conflict(error.message, error.code);
    return serverError(error);
  }
}
