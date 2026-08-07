import { notFound, serverError } from "@/server/http/respond";
import { buildTaskExport } from "@/server/pipeline/audit/export";

type Params = { id: string };

/**
 * `GET /api/tasks/:id/export[?transcripts=0]` — one task's complete record as
 * a single downloadable JSON file. See spec-audit-trail.md §9.
 *
 * There is no corresponding import route: this is a record, not a backup
 * (§9.2).
 */
export async function GET(request: Request, context: { params: Promise<Params> }) {
  try {
    const { id } = await context.params;
    const includeTranscripts = new URL(request.url).searchParams.get("transcripts") !== "0";

    const record = buildTaskExport(id, { includeTranscripts });
    if (!record) return notFound(`Task ${id} not found.`);

    return new Response(JSON.stringify(record, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="task-${id}.json"`,
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
