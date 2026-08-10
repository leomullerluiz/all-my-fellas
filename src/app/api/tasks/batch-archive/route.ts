import { json, parseBody, serverError } from "@/server/http/respond";
import { archiveTasksBatch } from "@/server/pipeline/orchestrator";
import { batchTaskIdsSchema } from "@/server/validation/schemas";

/**
 * `POST /api/tasks/batch-archive` — archives several tasks in one call (S4).
 * Always 200 with a per-task result, same shape as `batch-start`: archiving
 * has no admission control to fail on, so the only per-task outcomes are
 * "archived" or "already archived"/"not found".
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, batchTaskIdsSchema);
    if (!parsed.ok) return parsed.response;

    const results = archiveTasksBatch(parsed.data.taskIds);
    return json({ results });
  } catch (error) {
    return serverError(error);
  }
}
