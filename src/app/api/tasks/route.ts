import { badRequest, json, parseBody, serverError } from "@/server/http/respond";
import { CapacityError, capacity, startTask } from "@/server/pipeline/orchestrator";
import { createTask, getRepo, getTask, listTasks, totalCostForTask } from "@/server/tasks/service";
import { createTaskSchema, listTasksQuerySchema } from "@/server/validation/schemas";

/** `GET /api/tasks?status=` — board and list views, plus current capacity. */
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
    return json({ tasks, capacity: capacity() });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * `POST /api/tasks` — creates a task at `CREATED`.
 *
 * The pipeline is entered only when `start: true`. A capacity refusal still
 * leaves the task created, so the work is not lost — the user can start it once
 * a slot frees.
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, createTaskSchema);
    if (!parsed.ok) return parsed.response;

    if (!getRepo(parsed.data.repoId)) {
      return badRequest("That repository connection no longer exists.");
    }

    const created = createTask(parsed.data);
    if (!parsed.data.start) {
      return json({ task: created, started: false }, { status: 201 });
    }

    try {
      startTask(created.id);
      return json({ task: getTask(created.id) ?? created, started: true }, { status: 201 });
    } catch (error) {
      if (error instanceof CapacityError) {
        // The task is created and safe at `CREATED`; only the optional start
        // was refused. Return 409 with the task so the client can navigate to
        // it instead of losing the input.
        return json(
          { task: created, started: false, error: error.message },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error) {
    return serverError(error);
  }
}
