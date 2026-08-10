import { resolveGeminiAuth, resolveModels, resolveOpenAiAuth, resolveProviderAuth, type ProviderAuth } from "./env";

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

/**
 * The three model tiers `resolveModels()` has always defined
 * (`MODEL_LIGHT`/`MODEL_DEFAULT`/`MODEL_HEAVY`), now first-class past
 * `defaultSettings()` — see stories.md S3. A stage stores which tier it
 * wants, not the literal id, so switching a role's provider does not strand
 * it on a model id the new provider does not understand.
 */
export const MODEL_TIERS = ["light", "default", "heavy"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Per-provider model id for each tier — what the picker offers, and what a
 * `{ tier }` selection resolves to at execution time. Claude's column comes
 * from `resolveModels()` (env-configurable, unchanged by this story);
 * ChatGPT and Gemini use fixed ids chosen to already exist in `pricing.ts`'s
 * table, so picking a tier is never a silent $0. Computed fresh on every
 * call rather than a module constant, matching `env.ts`'s own "nothing
 * cached across calls" rule — a `.env` edit takes effect on the next stage
 * run, not just the next process restart.
 */
export function tierModels(): Record<LlmProviderId, Record<ModelTier, string>> {
  const claude = resolveModels();
  return {
    claude: { light: claude.light, default: claude.default, heavy: claude.heavy },
    chatgpt: { light: "gpt-4.1-mini", default: "gpt-4.1", heavy: "o3" },
    gemini: { light: "gemini-2.5-flash", default: "gemini-2.5-pro", heavy: "gemini-2.5-pro" },
  };
}

/**
 * A stage's stored model choice: a tier that resolves per provider, or an
 * escape-hatch literal for a model id the tier table does not know about yet
 * (§6.2 of the brief — forcing a release to wait for the table would be
 * worse than letting a literal through).
 */
export type ModelSelection = { tier: ModelTier } | { literal: string };

/** Resolves a stage's stored selection into the literal id a provider needs. */
export function resolveModelId(provider: LlmProviderId, selection: ModelSelection): string {
  return "literal" in selection ? selection.literal : tierModels()[provider][selection.tier];
}
