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
  /** Called for each observable event so the worker can persist it for SSE. */
  onEvent: (event: PipelineEvent) => void;
};

export class StageExecutionError extends Error {
  constructor(
    message: string,
    readonly partial: Partial<StageExecutionResult> = {},
  ) {
    super(message);
    this.name = "StageExecutionError";
  }
}
