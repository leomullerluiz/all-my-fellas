import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeminiClient } from "@/server/pipeline/providers/gemini";
import type { OpenAiChatClient } from "@/server/pipeline/providers/openai";
import { pingGemini, pingOpenAi, pingProvider } from "@/server/pipeline/providers/ping";
import { StageExecutionError } from "@/server/pipeline/providers/types";

/**
 * Unit tests for `ping.ts`, the diagnostic round trip behind Settings' "Test
 * connection" control. Same injectable-client pattern as
 * `run-stage-openai.test.ts`/`run-stage-gemini.test.ts`: no live credential
 * or network access in CI, so success is only verified against a fake
 * client. Claude's `query()` cannot be injected the same way (see
 * `run-stage.ts`'s provider tests, which don't fake it either), so only its
 * missing-credential path is covered here.
 */

const originalEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  vi.useRealTimers();
});

describe("pingClaude (via pingProvider)", () => {
  it("throws naming the missing Claude credential without calling the SDK", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    await expect(pingProvider("claude")).rejects.toThrow(/Claude credential/);
  });
});

describe("pingOpenAi", () => {
  it("throws naming OPENAI_API_KEY when the credential is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(pingOpenAi({} as OpenAiChatClient)).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("extracts the reply text and sends the literal message 'test'", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";

    let sentMessages: unknown;
    const fakeClient: OpenAiChatClient = {
      chat: {
        completions: {
          create: async ({ messages }) => {
            sentMessages = messages;
            return {
              choices: [{ message: { role: "assistant", content: "test received" }, finish_reason: "stop" }],
            };
          },
        },
      },
    };

    const text = await pingOpenAi(fakeClient);

    expect(text).toBe("test received");
    expect(sentMessages).toEqual([{ role: "user", content: "test" }]);
  });

  it("throws when the reply has no text", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";

    const emptyClient: OpenAiChatClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          }),
        },
      },
    };

    await expect(pingOpenAi(emptyClient)).rejects.toThrow(StageExecutionError);
  });

  it("rejects with a timeout error when the call never settles", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    vi.useFakeTimers();

    const hangingClient: OpenAiChatClient = {
      chat: {
        completions: {
          create: () => new Promise(() => {}),
        },
      },
    };

    const pending = pingOpenAi(hangingClient);
    const assertion = expect(pending).rejects.toThrow(/did not respond within/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
});

describe("pingGemini", () => {
  it("throws naming the missing credential when GEMINI_API_KEY/GOOGLE_API_KEY are unset", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    await expect(pingGemini({} as GeminiClient)).rejects.toThrow(/GEMINI_API_KEY|GOOGLE_API_KEY/);
  });

  it("extracts the reply text and sends the literal message 'test'", async () => {
    process.env.GEMINI_API_KEY = "gm-test-123";

    let sentContents: unknown;
    const fakeClient: GeminiClient = {
      models: {
        generateContent: async ({ contents }) => {
          sentContents = contents;
          return {
            candidates: [{ content: { role: "model", parts: [{ text: "test received" }] } }],
          };
        },
      },
    };

    const text = await pingGemini(fakeClient);

    expect(text).toBe("test received");
    expect(sentContents).toEqual([{ role: "user", parts: [{ text: "test" }] }]);
  });

  it("throws when the reply has no text", async () => {
    process.env.GEMINI_API_KEY = "gm-test-123";

    const emptyClient: GeminiClient = {
      models: {
        generateContent: async () => ({ candidates: [{ content: { role: "model", parts: [] } }] }),
      },
    };

    await expect(pingGemini(emptyClient)).rejects.toThrow(StageExecutionError);
  });
});
