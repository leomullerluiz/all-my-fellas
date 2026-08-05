import { resolveGeminiAuth, resolveOpenAiAuth, resolveProviderAuth, type ProviderAuth } from "./env";

/**
 * The set of LLM backends a pipeline stage can run against.
 *
 * Adding a provider here is only the vocabulary change: the actual dispatch
 * lives in `pipeline/providers/`, and a stage still needs a model id that
 * provider understands (see `AppSettings.models`).
 */
export const LLM_PROVIDER_IDS = ["claude", "chatgpt", "gemini"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
  claude: "Claude (Anthropic)",
  chatgpt: "ChatGPT (OpenAI)",
  gemini: "Gemini (Google)",
};

/** Same `ProviderAuth` shape as `resolveProviderAuth`, dispatched by provider id. */
export function resolveLlmProviderAuth(provider: LlmProviderId): ProviderAuth {
  switch (provider) {
    case "claude":
      return resolveProviderAuth();
    case "chatgpt":
      return resolveOpenAiAuth();
    case "gemini":
      return resolveGeminiAuth();
  }
}

/** Credential status for every provider, keyed for the Settings screen. */
export function resolveAllLlmCredentials(): Record<LlmProviderId, ProviderAuth> {
  return {
    claude: resolveProviderAuth(),
    chatgpt: resolveOpenAiAuth(),
    gemini: resolveGeminiAuth(),
  };
}
