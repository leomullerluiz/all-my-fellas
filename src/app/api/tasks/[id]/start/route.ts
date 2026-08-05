import { conflict, json, notFound, serverError } from "@/server/http/respond";
import {
  CapacityError,
  DependencyError,
  TaskNotFoundError,
  startTask,
} from "@/server/pipeline/orchestrator";
import { InvalidTransitionError } from "@/server/pipeline/state-machine";
import { getTask } from "@/server/tasks/service";

/**
 * `POST /api/tasks/:id/start` — enters the pipeline.
 *
 * All refusals are 409 rather than 500: a board up to four seconds stale, a
 * second tab, or an unfinished prerequisite all make them ordinary outcomes
 * rather than server faults.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    return json({ transition: startTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof CapacityError) return conflict(error.message);
    if (error instanceof DependencyError) return conflict(error.message);
    if (error instanceof InvalidTransitionError) {
      return conflict("This task has already been started.");
    }
    return serverError(error);
  }
}
