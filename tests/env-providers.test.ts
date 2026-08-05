import { afterEach, describe, expect, it } from "vitest";

import {
  resolveGeminiAuth,
  resolveOpenAiAuth,
  resolveProviderAuth,
} from "@/server/config/env";
import { LLM_PROVIDER_IDS, resolveAllLlmCredentials, resolveLlmProviderAuth } from "@/server/config/llm-providers";

/**
 * Credential resolution for the three LLM providers (S1, S2, S3).
 *
 * Mirrors the shape `tests/providers.test.ts` uses for the git-hosting
 * credential checks — present/missing, never the secret value itself.
 */

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  clearEnv();
});

describe("resolveOpenAiAuth", () => {
  it("reports missing when OPENAI_API_KEY is unset", () => {
    clearEnv();
    expect(resolveOpenAiAuth().mode).toBe("missing");
  });

  it("reports api_key when OPENAI_API_KEY is set", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "sk-test-123";
    const auth = resolveOpenAiAuth();
    expect(auth.mode).toBe("api_key");
    expect(auth.label).not.toContain("sk-test-123");
  });
});

describe("resolveGeminiAuth", () => {
  it("reports missing when neither GEMINI_API_KEY nor GOOGLE_API_KEY is set", () => {
    clearEnv();
    expect(resolveGeminiAuth().mode).toBe("missing");
  });

  it("reports api_key when GEMINI_API_KEY is set", () => {
    clearEnv();
    process.env.GEMINI_API_KEY = "gm-test-123";
    expect(resolveGeminiAuth().mode).toBe("api_key");
  });

  it("reports api_key when GOOGLE_API_KEY is set", () => {
    clearEnv();
    process.env.GOOGLE_API_KEY = "goog-test-123";
    expect(resolveGeminiAuth().mode).toBe("api_key");
  });
});

describe("resolveLlmProviderAuth", () => {
  it("dispatches to the matching per-provider check", () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-oai-test";

    expect(resolveLlmProviderAuth("claude")).toEqual(resolveProviderAuth());
    expect(resolveLlmProviderAuth("chatgpt")).toEqual(resolveOpenAiAuth());
    expect(resolveLlmProviderAuth("gemini")).toEqual(resolveGeminiAuth());
  });

  it("covers every declared provider id", () => {
    clearEnv();
    const all = resolveAllLlmCredentials();
    for (const id of LLM_PROVIDER_IDS) {
      expect(all[id].mode).toBe("missing");
    }
  });
});
