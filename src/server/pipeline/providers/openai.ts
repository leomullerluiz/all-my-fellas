import OpenAI from "openai";

import { resolveOpenAiAuth } from "../../config/env";
import { buildStagePrompt, buildSystemPrompt } from "../prompt";
import { estimateCostUsd } from "./pricing";
import { executeTool, summarizeToolInput, toolSchemasForRole } from "./tool-runtime";
import { StageExecutionError, type RunStageOptions, type StageExecutionResult } from "./types";

/**
 * Executes one pipeline stage against the OpenAI (ChatGPT) API.
 *
 * Unlike Claude's SDK, `openai`'s chat-completions client only does model
 * calls with function/tool-calling: executing a requested tool and feeding
 * the result back is done here, in a manual loop bounded by `maxTurns`.
 */

/** Minimal shape of what this module needs from the OpenAI client, so tests
 *  can inject a fake without implementing the whole SDK surface. */
export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

export type OpenAiChatClient = {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: OpenAiMessage[];
        tools?: Array<{
          type: "function";
          function: { name: string; description?: string; parameters: unknown };
        }>;
        signal?: AbortSignal;
      }): Promise<{
        choices: Array<{ message: OpenAiMessage; finish_reason: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
};

/** Verifies an OpenAI credential is present before spending time on setup. */
export function assertOpenAiConfigured(): void {
  const auth = resolveOpenAiAuth();
  if (auth.mode === "missing") {
    throw new StageExecutionError(
      "No OpenAI credential found. Set OPENAI_API_KEY in your .env file.",
    );
  }
}

function defaultClient(): OpenAiChatClient {
  // `new OpenAI()` reads `OPENAI_API_KEY` from the environment itself, the
  // same way the Claude Agent SDK picks up its own credential — no secret
  // passes through this module's own code.
  return new OpenAI() as unknown as OpenAiChatClient;
}

export async function runOpenAiStage(
  options: RunStageOptions,
  client: OpenAiChatClient = defaultClient(),
): Promise<StageExecutionResult> {
  assertOpenAiConfigured();

  const { role, workspacePath } = options;
  const tools = toolSchemasForRole(role).map((schema) => ({
    type: "function" as const,
    function: { name: schema.name, description: schema.description, parameters: schema.parameters },
  }));

  const messages: OpenAiMessage[] = [
    { role: "system", content: buildSystemPrompt(role) },
    { role: "user", content: buildStagePrompt(options.prompt) },
  ];

  // `messages` is the transcript: the model's own responses are pushed onto it
  // below, but so is the system message, the user prompt and every tool
  // result — the full conversation, not just the half `response` alone would
  // carry. See spec-audit-trail.md §12.3.
  const transcript: unknown[] = messages;
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let turn = 0;

  while (turn < options.maxTurns) {
    // A stop-loss, not a hard cap (§5.3): this can only ever check the cost
    // of turns already taken, since the API reports usage after a turn
    // completes, never before. Checked at the top of the loop so it also
    // covers the between-turns case — a cancellation-style check for cost
    // instead of an abort signal.
    if (options.maxCostUsd !== undefined) {
      const spent = estimateCostUsd(options.model, inputTokens, outputTokens);
      if (spent >= options.maxCostUsd) {
        throw new StageExecutionError(
          `The ${role.name} session stopped after ${turn} turn(s): spend ceiling of ` +
            `${options.maxCostUsd} USD reached (${spent.toFixed(4)} USD spent).`,
          { costUsd: spent, inputTokens, outputTokens, numTurns: turn, transcript },
          false,
        );
      }
    }

    turn++;

    const response = await client.chat.completions.create({
      model: options.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      signal: options.abortController?.signal,
    });
    inputTokens += response.usage?.prompt_tokens ?? 0;
    outputTokens += response.usage?.completion_tokens ?? 0;

    const message = response.choices[0]?.message;
    if (!message) {
      throw new StageExecutionError(`The ${role.name} session returned no message.`, {
        inputTokens,
        outputTokens,
        numTurns: turn,
        transcript,
      });
    }
    messages.push(message);

    if (message.content && message.content.trim() !== "") {
      options.onEvent({ type: "agent_text", text: message.content });
    }

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalText = message.content ?? "";
      break;
    }

    if (workspacePath === null) {
      throw new StageExecutionError(`The ${role.name} role runs without filesystem access.`, {
        inputTokens,
        outputTokens,
        numTurns: turn,
        transcript,
      });
    }

    for (const call of toolCalls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // Malformed JSON from the model — the tool below will reject it on
        // its own required-field checks.
      }

      options.onEvent({
        type: "agent_tool_use",
        tool: name,
        summary: summarizeToolInput(name, args),
      });

      const result = await executeTool(name, args, role, workspacePath);
      if (result.isError) {
        options.onEvent({ type: "agent_tool_denied", tool: name, reason: result.output });
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
    }
  }

  const costUsd = estimateCostUsd(options.model, inputTokens, outputTokens);

  if (finalText.trim() === "") {
    throw new StageExecutionError(
      `The ${role.name} session ended without final text after ${turn} turns (limit ${options.maxTurns}).`,
      { costUsd, inputTokens, outputTokens, numTurns: turn, transcript },
    );
  }

  return {
    sessionId: null,
    finalText,
    costUsd,
    inputTokens,
    outputTokens,
    numTurns: turn,
    transcript,
  };
}
