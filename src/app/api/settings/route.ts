import { hasGithubToken, resolveProviderAuth } from "@/server/config/env";
import { json, parseBody, serverError } from "@/server/http/respond";
import { getSettings, updateSettings } from "@/server/settings/store";
import { updateSettingsSchema } from "@/server/validation/schemas";

/** `GET /api/settings` — effective settings plus provider status. */
export async function GET() {
  try {
    const auth = resolveProviderAuth();
    return json({
      settings: getSettings(),
      provider: { mode: auth.mode, label: auth.label },
      githubTokenPresent: hasGithubToken(),
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
