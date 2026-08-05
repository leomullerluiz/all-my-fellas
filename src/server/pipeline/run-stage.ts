import type { LlmProviderId } from "../config/llm-providers";
import { assertClaudeConfigured, runClaudeStage } from "./providers/claude";
import { assertGeminiConfigured, runGeminiStage } from "./providers/gemini";
import { assertOpenAiConfigured, runOpenAiStage } from "./providers/openai";
import { StageExecutionError, type RunStageOptions, type StageExecutionResult } from "./providers/types";

/**
 * Provider dispatcher for pipeline stage execution.
 *
 * Every stage run picks one of three independent SDK backends — Claude,
 * ChatGPT (OpenAI) or Gemini — behind the same `RunStageOptions` in,
 * `StageExecutionResult` out contract. The dispatcher itself holds no
 * provider-specific logic; that lives in `./providers/*.ts`.
 */

export { StageExecutionError, type RunStageOptions, type StageExecutionResult } from "./providers/types";

/** Verifies the selected provider's credential is present before setup. */
export function assertProviderConfigured(provider: LlmProviderId): void {
  switch (provider) {
    case "claude":
      assertClaudeConfigured();
      return;
    case "chatgpt":
      assertOpenAiConfigured();
      return;
    case "gemini":
      assertGeminiConfigured();
      return;
  }
}

export async function runStage(
  provider: LlmProviderId,
  options: RunStageOptions,
): Promise<StageExecutionResult> {
  switch (provider) {
    case "claude":
      return runClaudeStage(options);
    case "chatgpt":
      return runOpenAiStage(options);
    case "gemini":
      return runGeminiStage(options);
    default: {
      const exhaustive: never = provider;
      throw new StageExecutionError(`Unknown LLM provider "${String(exhaustive)}".`);
    }
  }
}
