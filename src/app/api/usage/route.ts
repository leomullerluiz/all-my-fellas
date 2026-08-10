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

    // Passed by name, not by a millisecond cutoff computed here — `costPerTask`
    // takes a day count and computes its own cutoff. See stories.md S1.
    const perTask = costPerTask(parsed.data.days);
    return json({
      byStage: usageByStage(parsed.data.taskId, parsed.data.days),
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
