/**
 * Static per-model pricing for ChatGPT and Gemini cost estimates.
 *
 * Unlike Claude's SDK, which reports `total_cost_usd` computed by Anthropic
 * itself, OpenAI's and Gemini's chat-completion APIs return token counts only
 * — the dollar figure is our own estimate from a locally maintained table. It
 * WILL drift as providers change pricing, and an unrecognized model id
 * silently reports $0 rather than guessing. Treat `costUsd` from these two
 * providers as an estimate, not a bill — this is called out in
 * `docs/llm-providers.md` and on the Settings screen.
 *
 * Prices are USD per 1M tokens, current as of this file's last edit.
 */

type ModelPricing = { inputPerMillion: number; outputPerMillion: number };

const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "o3": { inputPerMillion: 2, outputPerMillion: 8 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  // Gemini
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

/** Returns `0` for a model id not in the table rather than guessing. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}
