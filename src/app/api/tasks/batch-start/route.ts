import { json, parseBody, serverError } from "@/server/http/respond";
import { startTasksBatch } from "@/server/pipeline/orchestrator";
import { batchStartSchema } from "@/server/validation/schemas";

/**
 * `POST /api/tasks/batch-start` — starts several `CREATED` tasks in one call.
 *
 * Each task is started through the same admission-controlled path as
 * `POST /api/tasks/:id/start`, in priority/difficulty order; one task's
 * failure does not stop the rest, so this always returns 200 with a
 * per-task result rather than an all-or-nothing status code.
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, batchStartSchema);
    if (!parsed.ok) return parsed.response;

    const results = startTasksBatch(parsed.data.taskIds);
    return json({ results });
  } catch (error) {
    return serverError(error);
  }
}
