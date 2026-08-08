import type { RoleDefinition } from "../../agents/roles";
import type { PipelineEvent } from "../../events/store";
import type { StagePromptInput } from "../prompt";

/**
 * The contract every LLM provider module (`claude.ts`, `openai.ts`,
 * `gemini.ts`) implements. `run-stage.ts` dispatches to one of these by
 * `RunStageOptions`'s implicit provider selection; nothing downstream of a
 * stage run needs to know which SDK produced the result.
 */

export type StageExecutionResult = {
  sessionId: string | null;
  /** Final assistant text; this is the artifact body. */
  finalText: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  /**
   * Full message stream, persisted to `agent_runs` for auditing only.
   *
   * `unknown[]` rather than a provider-specific message type: Claude, OpenAI
   * and Gemini each have their own transcript shape, and nothing reads this
   * back into the pipeline — it is a JSON blob for humans.
   */
  transcript: unknown[];
};

export type RunStageOptions = {
  role: RoleDefinition;
  prompt: StagePromptInput;
  model: string;
  maxTurns: number;
  /** Absolute workspace path, or `null` for the text-only Stakeholder role. */
  workspacePath: string | null;
  abortController?: AbortController;
  /**
   * Per-stage dollar ceiling (`settings.maxCostPerStageUsd`). `undefined`
   * means no ceiling. A stop-loss, not a hard cap: every provider can only
   * check *after* the turn that crosses it, since none reports what a turn
   * will cost before running it (§5.3).
   */
  maxCostUsd?: number;
  /** Called for each observable event so the worker can persist it for SSE. */
  onEvent: (event: PipelineEvent) => void;
};

export class StageExecutionError extends Error {
  constructor(
    message: string,
    readonly partial: Partial<StageExecutionResult> = {},
    /**
     * `false` for a budget stop (§5.4) — re-running the same session would
     * just spend up to the ceiling again. `execute.ts` reads this to mark the
     * `StageJobError` it throws non-retryable, matching the pattern
     * `artifact_invalid` already uses for a validation failure.
     */
    readonly retryable = true,
  ) {
    super(message);
    this.name = "StageExecutionError";
  }
}

/**
 * Raised by a provider when `options.abortController`'s signal fired mid-session
 * (§6.5) — the user clicked Cancel, not a crash. Always non-retryable: the
 * task already reached `CANCELLED` via `cancelTask` before the abort landed,
 * so nothing should retry it or advance the task a second time.
 *
 * A subclass rather than a discriminator field so `error instanceof
 * StageAbortedError` reads the same way every other typed-error check in
 * this codebase already does (`CapacityError`, `QuotaError`, …).
 */
export class StageAbortedError extends StageExecutionError {
  constructor(message: string, partial: Partial<StageExecutionResult> = {}) {
    super(message, partial, false);
    this.name = "StageAbortedError";
  }
}
