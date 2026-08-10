import { json, parseBody, serverError } from "@/server/http/respond";
import { cancelTasksBatch } from "@/server/pipeline/orchestrator";
import { batchTaskIdsSchema } from "@/server/validation/schemas";

/**
 * `POST /api/tasks/batch-cancel` — cancels several tasks in one call (S4).
 * Always 200 with a per-task result; one task's refusal does not stop the
 * rest, same convention as `batch-start` and `batch-archive`.
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, batchTaskIdsSchema);
    if (!parsed.ok) return parsed.response;

    const results = cancelTasksBatch(parsed.data.taskIds);
    return json({ results });
  } catch (error) {
    return serverError(error);
  }
}
