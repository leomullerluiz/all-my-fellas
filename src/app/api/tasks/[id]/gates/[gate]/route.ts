import { badRequest, conflict, json, notFound, parseBody, serverError } from "@/server/http/respond";
import { GateError, TaskNotFoundError, decideGate } from "@/server/pipeline/orchestrator";
import { gateDecisionSchema, gateParamSchema } from "@/server/validation/schemas";

/** `POST /api/tasks/:id/gates/:gate` — records a human approval decision. */
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

    const transition = decideGate({
      taskId: id,
      gate: parsedGate.data,
      decision: parsed.data.decision,
      comment: parsed.data.comment,
    });

    return json({ transition });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
