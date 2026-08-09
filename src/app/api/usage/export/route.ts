import { badRequest, serverError } from "@/server/http/respond";
import { stageRunsToCsv } from "@/server/usage/csv";
import { stageRunExport } from "@/server/tasks/service";
import { usageQuerySchema } from "@/server/validation/schemas";

/**
 * `GET /api/usage/export?days=&taskId=` — one CSV row per `stage_runs` row,
 * including `failed`/`cancelled` runs, at the grain someone reconciling
 * against a provider invoice needs. See stories.md S5.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = usageQuerySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined,
      taskId: url.searchParams.get("taskId") ?? undefined,
    });
    if (!parsed.success) return badRequest("Invalid usage query.");

    const csv = stageRunsToCsv(stageRunExport(parsed.data));

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="stage-runs.csv"',
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
