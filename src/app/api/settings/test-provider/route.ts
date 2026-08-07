import { LLM_PROVIDER_LABELS } from "@/server/config/llm-providers";
import { badRequest, json, parseBody, serverError } from "@/server/http/respond";
import { pingProvider } from "@/server/pipeline/providers/ping";
import { StageExecutionError } from "@/server/pipeline/providers/types";
import { testProviderSchema } from "@/server/validation/schemas";

/**
 * `POST /api/settings/test-provider` — sends the literal message `"test"` to
 * one LLM provider and returns its reply, for the Settings "Test connection"
 * control. Never touches the task/pipeline store: `pingProvider` runs
 * entirely outside `runStage`.
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, testProviderSchema);
    if (!parsed.ok) return parsed.response;

    const { provider } = parsed.data;
    const text = await pingProvider(provider);
    return json({ provider, label: LLM_PROVIDER_LABELS[provider], text });
  } catch (error) {
    if (error instanceof StageExecutionError) return badRequest(error.message);
    return serverError(error);
  }
}
