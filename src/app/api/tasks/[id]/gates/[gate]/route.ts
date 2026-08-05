import { badRequest, conflict, json, notFound, parseBody, serverError } from "@/server/http/respond";
import { GateError, TaskNotFoundError, decideGate } from "@/server/pipeline/orchestrator";
import { gateDecisionSchema, gateParamSchema } from "@/server/validation/schemas";

/**
 * `POST /api/tasks/:id/gates/:gate` — records a human approval decision.
 *
 * A `run` decision made while no slot is free is queued rather than
 * refused — `decideGate` never throws `CapacityError` for it, so there is no
 * matching catch branch here. `result.queued` tells the caller whether
 * execution resumed immediately or is waiting for `promoteQueue`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; gate: string }> },
) {
  try {
    const { id, gate } = await context.params;

    const parsedGate = gateParamSchema.safeParse(gate.toUpperCase());
    if (!parsedGate.success) return badRequest(`Unknown gate "${gate}".`);

    const parsed = await parseBody(request, gateDecisionSchema);
    if (!parsed.ok) return parsed.response;

    const result = decideGate({
      taskId: id,
      gate: parsedGate.data,
      decision: parsed.data.decision,
      comment: parsed.data.comment,
    });

    return json(result);
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
