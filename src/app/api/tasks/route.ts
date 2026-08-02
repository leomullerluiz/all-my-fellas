import { badRequest, json, parseBody, serverError } from "@/server/http/respond";
import { createAndStartTask } from "@/server/pipeline/orchestrator";
import { getRepo, listTasks, totalCostForTask } from "@/server/tasks/service";
import { createTaskSchema, listTasksQuerySchema } from "@/server/validation/schemas";

/** `GET /api/tasks?status=` — board and list views. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = listTasksQuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
    });
    if (!parsed.success) return badRequest("Unknown status filter.");

    const tasks = listTasks(parsed.data).map((task) => ({
      ...task,
      costUsd: totalCostForTask(task.id),
    }));
    return json({ tasks });
  } catch (error) {
    return serverError(error);
  }
}

/** `POST /api/tasks` — creates a task and enters the pipeline. */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, createTaskSchema);
    if (!parsed.ok) return parsed.response;

    if (!getRepo(parsed.data.repoId)) {
      return badRequest("That repository connection no longer exists.");
    }

    const task = createAndStartTask(parsed.data);
    return json({ task }, { status: 201 });
  } catch (error) {
    return serverError(error);
  }
}
