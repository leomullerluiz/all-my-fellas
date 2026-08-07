import { GoogleGenAI } from "@google/genai";

import { resolveGeminiAuth } from "../../config/env";
import { buildStagePrompt, buildSystemPrompt } from "../prompt";
import { estimateCostUsd } from "./pricing";
import { executeTool, summarizeToolInput, toolSchemasForRole } from "./tool-runtime";
import { StageExecutionError, type RunStageOptions, type StageExecutionResult } from "./types";

/**
 * Executes one pipeline stage against the Gemini API.
 *
 * Same shape as `openai.ts`: Gemini's SDK only does model calls with
 * function declarations, so tool execution is driven by the same
 * `tool-runtime.ts` loop, just adapted to Gemini's `Content`/`Part` message
 * format instead of OpenAI's chat-message format.
 */

export type GeminiFunctionCall = { name?: string; args?: Record<string, unknown> };

export type GeminiPart = {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name?: string; response?: Record<string, unknown> };
};

export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/** Minimal shape of what this module needs from the Gemini client, so tests
 *  can inject a fake without implementing the whole SDK surface. */
export type GeminiClient = {
  models: {
    generateContent(params: {
      model: string;
      contents: GeminiContent[];
      config?: {
        systemInstruction?: string;
        tools?: Array<{
          functionDeclarations: Array<{ name: string; description?: string; parametersJsonSchema?: unknown }>;
        }>;
      };
    }): Promise<{
      candidates?: Array<{ content?: GeminiContent }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
  };
};

/** Verifies a Gemini credential is present before spending time on setup. */
export function assertGeminiConfigured(): void {
  const auth = resolveGeminiAuth();
  if (auth.mode === "missing") {
    throw new StageExecutionError(
      "No Gemini credential found. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in your .env file.",
    );
  }
}

function defaultClient(): GeminiClient {
  // `new GoogleGenAI({})` reads `GOOGLE_API_KEY`/`GEMINI_API_KEY` from the
  // environment itself, the same as the Claude Agent SDK's own credential
  // pickup — no secret passes through this module's own code.
  return new GoogleGenAI({}) as unknown as GeminiClient;
}

export async function runGeminiStage(
  options: RunStageOptions,
  client: GeminiClient = defaultClient(),
): Promise<StageExecutionResult> {
  assertGeminiConfigured();

  const { role, workspacePath } = options;
  const schemas = toolSchemasForRole(role);
  const tools =
    schemas.length > 0
      ? [
          {
            functionDeclarations: schemas.map((schema) => ({
              name: schema.name,
              description: schema.description,
              parametersJsonSchema: schema.parameters,
            })),
          },
        ]
      : undefined;

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: buildStagePrompt(options.prompt) }] },
  ];

  // `contents` is the transcript: the model's own turns are pushed onto it
  // below, but so is the initial user prompt and every function-call result —
  // the full conversation, not just the half a per-call `response` alone
  // would carry. See spec-audit-trail.md §12.3. The system instruction is not
  // part of `contents` in Gemini's API shape; it is captured separately on
  // `stage_runs.system_prompt` (§4).
  const transcript: unknown[] = contents;
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let turn = 0;

  while (turn < options.maxTurns) {
    turn++;

    const response = await client.models.generateContent({
      model: options.model,
      contents,
      config: { systemInstruction: buildSystemPrompt(role), tools },
    });

    inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

    const candidateContent = response.candidates?.[0]?.content;
    const parts = candidateContent?.parts ?? [];
    if (parts.length === 0) {
      throw new StageExecutionError(`The ${role.name} session returned no content.`, {
        inputTokens,
        outputTokens,
        numTurns: turn,
        transcript,
      });
    }
    contents.push({ role: "model", parts });

    const text = parts
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (text !== "") options.onEvent({ type: "agent_text", text });

    const functionCalls = parts
      .map((part) => part.functionCall)
      .filter((call): call is GeminiFunctionCall => call !== undefined);

    if (functionCalls.length === 0) {
      finalText = text;
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

    const responseParts: GeminiPart[] = [];
    for (const call of functionCalls) {
      const name = call.name ?? "";
      const args = call.args ?? {};

      options.onEvent({
        type: "agent_tool_use",
        tool: name,
        summary: summarizeToolInput(name, args),
      });

      const result = await executeTool(name, args, role, workspacePath);
      if (result.isError) {
        options.onEvent({ type: "agent_tool_denied", tool: name, reason: result.output });
      }

      responseParts.push({ functionResponse: { name, response: { output: result.output } } });
    }
    contents.push({ role: "user", parts: responseParts });
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
