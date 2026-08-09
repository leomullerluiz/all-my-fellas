import { conflict, json, notFound, serverError } from "@/server/http/respond";
import {
  CapacityError,
  DependencyError,
  QuotaError,
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
 *
 * An optional `{ "overrideQuota": true }` JSON body is the "Start anyway"
 * affordance on a quota-held task — a blank/empty body is treated the same as
 * omitted, so the existing no-body callers are unaffected.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    let overrideQuota = false;
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        const body = JSON.parse(raw) as { overrideQuota?: unknown };
        overrideQuota = body.overrideQuota === true;
      } catch {
        // Malformed body on an endpoint that historically took none — ignore
        // rather than 400, the same tolerance an empty body already gets.
      }
    }

    return json({ transition: startTask(id, { overrideQuota }) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof QuotaError) return conflict(error.message, "quota_exceeded");
    if (error instanceof CapacityError) return conflict(error.message);
    if (error instanceof DependencyError) return conflict(error.message);
    if (error instanceof InvalidTransitionError) {
      return conflict("This task has already been started.");
    }
    return serverError(error);
  }
}
