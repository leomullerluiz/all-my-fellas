import { type CanUseTool, type Options, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";

import { formatCost } from "@/lib/utils";

import { resolveProviderAuth } from "../../config/env";
import { createPermissionGuard } from "../guardrails";
import { buildStagePrompt, buildSystemPrompt } from "../prompt";
import { summarizeToolInput } from "./tool-runtime";
import {
  StageAbortedError,
  StageExecutionError,
  type RunStageOptions,
  type StageExecutionResult,
} from "./types";

/**
 * Executes one pipeline stage as an isolated Claude Agent SDK session.
 *
 * Every stage is a fresh `query()` with no `resume`, which is what makes the
 * minimum-context handoff structural rather than a convention: there is no
 * session to leak from one role to the next.
 *
 * This is the original body of `run-stage.ts`, moved verbatim behind the
 * provider dispatcher in `../run-stage.ts` — Claude is a full local
 * coding-agent harness, so unlike the OpenAI/Gemini providers it needs no
 * manual tool-execution loop of its own.
 */

/**
 * Builds the SDK options for a stage.
 *
 * `allowedTools` is deliberately empty: nothing is auto-approved, so the
 * permission guard is consulted for every tool call.
 */
/**
 * Wraps the shared guard so a denial reaches the live log and the transcript
 * with the guard's own reason, at the moment it is decided — rather than the
 * generic string the `result` frame's `permission_denials` list carries with
 * no way to tell which rule fired. See spec-audit-trail.md §6.3.
 */
function buildGuard(options: RunStageOptions): CanUseTool {
  const guard = createPermissionGuard(options.role, options.workspacePath);
  return async (toolName, input, guardOptions) => {
    const verdict = await guard(toolName, input, guardOptions);
    if (verdict?.behavior === "deny") {
      options.onEvent({ type: "agent_tool_denied", tool: toolName, reason: verdict.message });
    }
    return verdict;
  };
}

/** Exported for `tests/claude-budget.test.ts`'s assertion on the built options object. */
export function buildOptions(options: RunStageOptions): Options {
  const { role, workspacePath } = options;

  return {
    model: options.model,
    systemPrompt: buildSystemPrompt(role),
    tools: role.allowedTools,
    allowedTools: [],
    permissionMode: role.permissionMode,
    canUseTool: buildGuard(options),
    cwd: workspacePath ?? process.cwd(),
    maxTurns: options.maxTurns,
    // A stop-loss, not a hard cap (§5.3/§5.7): the SDK stops the session once
    // this is exceeded, ending it with `error_max_budget_usd` rather than
    // silently continuing. `undefined` when no ceiling is configured — the
    // SDK option itself is optional for exactly that case.
    maxBudgetUsd: options.maxCostUsd,
    abortController: options.abortController,
    // Load the target repository's own CLAUDE.md, but nothing from the host
    // machine's user settings. Text-only roles get no settings at all.
    settingSources: workspacePath === null ? [] : ["project"],
    // Transcripts live in `agent_runs`; there is nothing to resume from disk.
    persistSession: false,
    strictMcpConfig: true,
    includePartialMessages: false,
  };
}

/** Verifies a Claude credential is present before spending time on setup. */
export function assertClaudeConfigured(): void {
  const auth = resolveProviderAuth();
  if (auth.mode === "missing") {
    throw new StageExecutionError(
      "No Claude credential found. Set CLAUDE_CODE_OAUTH_TOKEN (subscription) " +
        "or ANTHROPIC_API_KEY (pay per use) in your .env file.",
    );
  }
}

export async function runClaudeStage(options: RunStageOptions): Promise<StageExecutionResult> {
  assertClaudeConfigured();

  const transcript: SDKMessage[] = [];
  let sessionId: string | null = null;
  let finalText = "";
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;

  const stream = query({
    prompt: buildStagePrompt(options.prompt),
    options: buildOptions(options),
  });

  try {
    for await (const message of stream) {
      transcript.push(message);

      switch (message.type) {
        case "system": {
          if (message.subtype === "init") sessionId = message.session_id;
          break;
        }

        case "assistant": {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim() !== "") {
              options.onEvent({ type: "agent_text", text: block.text });
            } else if (block.type === "thinking") {
              options.onEvent({ type: "agent_thinking" });
            } else if (block.type === "tool_use") {
              options.onEvent({
                type: "agent_tool_use",
                tool: block.name,
                summary: summarizeToolInput(block.name, block.input),
              });
            }
          }
          break;
        }

        case "result": {
          costUsd = message.total_cost_usd;
          inputTokens = message.usage.input_tokens ?? 0;
          outputTokens = message.usage.output_tokens ?? 0;
          numTurns = message.num_turns;

          // Each denial was already surfaced with its real reason by `buildGuard`
          // at the moment `canUseTool` decided it; `permission_denials` here is
          // just the SDK's own after-the-fact tally and carries no reason string
          // worth re-emitting.

          if (message.subtype !== "success") {
            // A budget stop is a distinct, expected outcome — not a crash, and
            // not worth the worker's ordinary retry (which would spend up to
            // the ceiling again, twice more — turning a $5 cap into $15). See
            // §5.4/§5.7's distinction between a budget stop and `error_max_turns`.
            const isBudgetStop = message.subtype === "error_max_budget_usd";
            throw new StageExecutionError(
              `The ${options.role.name} session ended with "${message.subtype}"` +
                (message.subtype === "error_max_turns"
                  ? ` after ${message.num_turns} turns (limit ${options.maxTurns}).`
                  : isBudgetStop
                    ? ` — spend ceiling of ${formatCost(options.maxCostUsd ?? 0)} reached after ${message.num_turns} turn(s).`
                    : `: ${message.errors.join("; ") || "no further detail"}.`),
              { sessionId, costUsd, inputTokens, outputTokens, numTurns, transcript },
              !isBudgetStop,
            );
          }

          finalText = message.result;
          break;
        }

        default:
          // Status, retry, rate-limit and other informational frames are kept
          // in the transcript for auditing but are not surfaced to the
          // dashboard.
          break;
      }
    }
  } catch (error) {
    // The SDK's own reaction to an aborted `abortController` varies (a thrown
    // error, or the stream simply ending) — checking the signal directly
    // rather than sniffing the error shape catches either case. Cancel is not
    // a crash: the partial accumulated so far is still worth recording (§5.4),
    // and the worker must not retry it (§6.5).
    if (options.abortController?.signal.aborted) {
      throw new StageAbortedError(`The ${options.role.name} session was cancelled.`, {
        sessionId,
        costUsd,
        inputTokens,
        outputTokens,
        numTurns,
        transcript,
      });
    }
    throw error;
  }

  if (options.abortController?.signal.aborted) {
    // Covers the silent-end case: the stream finished with no error and no
    // `"result"` message at all once the signal fired.
    throw new StageAbortedError(`The ${options.role.name} session was cancelled.`, {
      sessionId,
      costUsd,
      inputTokens,
      outputTokens,
      numTurns,
      transcript,
    });
  }

  if (finalText.trim() === "") {
    throw new StageExecutionError(
      `The ${options.role.name} session produced no final output.`,
      { sessionId, costUsd, inputTokens, outputTokens, numTurns, transcript },
    );
  }

  return { sessionId, finalText, costUsd, inputTokens, outputTokens, numTurns, transcript };
}
