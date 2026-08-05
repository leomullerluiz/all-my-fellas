import { type Options, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";

import { resolveProviderAuth } from "../../config/env";
import { createPermissionGuard } from "../guardrails";
import { buildStagePrompt, buildSystemPrompt } from "../prompt";
import { summarizeToolInput } from "./tool-runtime";
import { StageExecutionError, type RunStageOptions, type StageExecutionResult } from "./types";

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
function buildOptions(options: RunStageOptions): Options {
  const { role, workspacePath } = options;

  return {
    model: options.model,
    systemPrompt: buildSystemPrompt(role),
    tools: role.allowedTools,
    allowedTools: [],
    permissionMode: role.permissionMode,
    canUseTool: createPermissionGuard(role, workspacePath),
    cwd: workspacePath ?? process.cwd(),
    maxTurns: options.maxTurns,
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

        for (const denial of message.permission_denials) {
          options.onEvent({
            type: "agent_tool_denied",
            tool: denial.tool_name,
            reason: "Blocked by the pipeline sandbox.",
          });
        }

        if (message.subtype !== "success") {
          throw new StageExecutionError(
            `The ${options.role.name} session ended with "${message.subtype}"` +
              (message.subtype === "error_max_turns"
                ? ` after ${message.num_turns} turns (limit ${options.maxTurns}).`
                : `: ${message.errors.join("; ") || "no further detail"}.`),
            { sessionId, costUsd, inputTokens, outputTokens, numTurns, transcript },
          );
        }

        finalText = message.result;
        break;
      }

      default:
        // Status, retry, rate-limit and other informational frames are kept in
        // the transcript for auditing but are not surfaced to the dashboard.
        break;
    }
  }

  if (finalText.trim() === "") {
    throw new StageExecutionError(
      `The ${options.role.name} session produced no final output.`,
      { sessionId, costUsd, inputTokens, outputTokens, numTurns, transcript },
    );
  }

  return { sessionId, finalText, costUsd, inputTokens, outputTokens, numTurns, transcript };
}
