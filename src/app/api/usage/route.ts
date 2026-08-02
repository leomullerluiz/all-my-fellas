import { badRequest, json, serverError } from "@/server/http/respond";
import { costPerTask, usageByStage } from "@/server/tasks/service";
import { usageQuerySchema } from "@/server/validation/schemas";

/** `GET /api/usage?days=&taskId=` — aggregated token and cost figures. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = usageQuerySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined,
      taskId: url.searchParams.get("taskId") ?? undefined,
    });
    if (!parsed.success) return badRequest("Invalid usage query.");

    const since = parsed.data.days
      ? Date.now() - parsed.data.days * 24 * 60 * 60 * 1000
      : undefined;

    const perTask = costPerTask(since);
    return json({
      byStage: usageByStage(parsed.data.taskId),
      byTask: perTask,
      totals: {
        costUsd: perTask.reduce((sum, row) => sum + row.costUsd, 0),
        inputTokens: perTask.reduce((sum, row) => sum + row.inputTokens, 0),
        outputTokens: perTask.reduce((sum, row) => sum + row.outputTokens, 0),
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
