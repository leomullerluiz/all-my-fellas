import { resolveProviderAuth } from "@/server/config/env";
import { resolveAllLlmCredentials } from "@/server/config/llm-providers";
import { conventionalEnvVars } from "@/server/git/credentials";
import { PROVIDERS } from "@/server/git/providers";
import { json, parseBody, serverError } from "@/server/http/respond";
import { getSettings, updateSettings } from "@/server/settings/store";
import { updateSettingsSchema } from "@/server/validation/schemas";

/** `GET /api/settings` — effective settings plus credential status. */
export async function GET() {
  try {
    const auth = resolveProviderAuth();
    return json({
      settings: getSettings(),
      provider: { mode: auth.mode, label: auth.label },
      /** Credential status for every selectable LLM provider, by provider id. */
      llmCredentials: resolveAllLlmCredentials(),
      credentials: conventionalEnvVars(PROVIDERS),
    });
  } catch (error) {
    return serverError(error);
  }
}

/** `PATCH /api/settings` — merges an override into the stored settings. */
export async function PATCH(request: Request) {
  try {
    const parsed = await parseBody(request, updateSettingsSchema);
    if (!parsed.ok) return parsed.response;
    return json({ settings: updateSettings(parsed.data) });
  } catch (error) {
    return serverError(error);
  }
}
