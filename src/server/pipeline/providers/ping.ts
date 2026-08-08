import { query } from "@anthropic-ai/claude-agent-sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

import { resolveModels } from "../../config/env";
import type { LlmProviderId } from "../../config/llm-providers";
import { assertClaudeConfigured } from "./claude";
import { assertGeminiConfigured, type GeminiClient } from "./gemini";
import { assertOpenAiConfigured, type OpenAiChatClient } from "./openai";
import { StageExecutionError } from "./types";

/**
 * A diagnostic "ping" per LLM provider, for the Settings "Test connection"
 * control.
 *
 * Deliberately independent of `runStage`/`RunStageOptions`: a ping has no
 * role, no workspace and no tool-execution loop, and must never touch either
 * — it sends the literal string `"test"` and reads back the reply. Every
 * failure mode (missing credential, empty response, timeout) is raised as a
 * `StageExecutionError`, so the route handler only has to catch one type.
 */

const PING_TIMEOUT_MS = 20_000;
const PING_MESSAGE = "test";

/**
 * Small, fast, widely available models picked only for this smoke test —
 * distinct from whatever model a role is actually configured with. See
 * "Test connection" in `docs/llm-providers.md`.
 */
const PING_MODELS = {
  chatgpt: "gpt-4o-mini",
  gemini: "gemini-3.5-flash",
} as const;

/** Rejects with a `StageExecutionError` if `promise` has not settled in time. */
function withTimeout<T>(promise: Promise<T>, providerLabel: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new StageExecutionError(
          `${providerLabel} did not respond within ${PING_TIMEOUT_MS / 1000}s.`,
        ),
      );
    }, PING_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function pingClaude(): Promise<string> {
  assertClaudeConfigured();

  const abortController = new AbortController();

  const run = (async () => {
    const stream = query({
      prompt: PING_MESSAGE,
      options: {
        model: resolveModels().light,
        tools: [],
        allowedTools: [],
        permissionMode: "default",
        maxTurns: 1,
        abortController,
        // No project CLAUDE.md, no host settings — a ping reads nothing off disk.
        settingSources: [],
        persistSession: false,
        strictMcpConfig: true,
        includePartialMessages: false,
      },
    });

    for await (const message of stream) {
      if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new StageExecutionError(
            `Claude ended the test session with "${message.subtype}".`,
          );
        }
        return message.result;
      }
    }
    return "";
  })();

  let text: string;
  try {
    text = await withTimeout(run, "Claude");
  } catch (error) {
    abortController.abort();
    throw error;
  }

  if (text.trim() === "") {
    throw new StageExecutionError("Claude returned no text in reply to the test message.");
  }
  return text;
}

function defaultOpenAiClient(): OpenAiChatClient {
  return new OpenAI() as unknown as OpenAiChatClient;
}

export async function pingOpenAi(client?: OpenAiChatClient): Promise<string> {
  assertOpenAiConfigured();
  // Guard first, construct second: `new OpenAI()` throws its own (less
  // friendly) error the moment it is built without a key, so the default
  // client is only created once the credential is known to be present.
  const activeClient = client ?? defaultOpenAiClient();

  const response = await withTimeout(
    activeClient.chat.completions.create({
      model: PING_MODELS.chatgpt,
      messages: [{ role: "user", content: PING_MESSAGE }],
    }),
    "ChatGPT",
  );

  const text = response.choices[0]?.message.content ?? "";
  if (text.trim() === "") {
    throw new StageExecutionError("ChatGPT returned no text in reply to the test message.");
  }
  return text;
}

function defaultGeminiClient(): GeminiClient {
  return new GoogleGenAI({}) as unknown as GeminiClient;
}

export async function pingGemini(client?: GeminiClient): Promise<string> {
  assertGeminiConfigured();
  const activeClient = client ?? defaultGeminiClient();

  const response = await withTimeout(
    activeClient.models.generateContent({
      model: PING_MODELS.gemini,
      contents: [{ role: "user", parts: [{ text: PING_MESSAGE }] }],
    }),
    "Gemini",
  );

  const text = (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (text === "") {
    throw new StageExecutionError("Gemini returned no text in reply to the test message.");
  }
  return text;
}

/** Dispatches to the ping for `provider`. See `LLM_PROVIDER_IDS`. */
export async function pingProvider(provider: LlmProviderId): Promise<string> {
  switch (provider) {
    case "claude":
      return pingClaude();
    case "chatgpt":
      return pingOpenAi();
    case "gemini":
      return pingGemini();
  }
}
