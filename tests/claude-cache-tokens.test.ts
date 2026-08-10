import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROLES } from "@/server/agents/roles";
import type { StagePromptInput } from "@/server/pipeline/prompt";

/**
 * stories.md S1 — the Claude adapter used to read only `usage.input_tokens`,
 * discarding `cache_read_input_tokens`/`cache_creation_input_tokens`. With
 * prompt caching active (the normal case for a multi-turn agent session) that
 * understated the recorded input tokens by roughly 1000×. This test fails
 * against that code.
 */

let fakeMessages: AsyncIterable<unknown>;
let queryMock: (...args: unknown[]) => unknown;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => {
    queryMock(...args);
    return fakeMessages;
  },
}));

const prompt: StagePromptInput = {
  role: ROLES.PO_REFINEMENT,
  task: {
    id: "task_1",
    title: "Login form",
    description: "As a user I want to log in.",
    priority: "medium",
    repoName: "acme/app",
    repoContext: null,
    branchName: "task/login-form",
  },
  artifacts: [],
  attempt: 1,
};

const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-test-123";
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe("runClaudeStage — cache token accounting (S1)", () => {
  it("sums input_tokens, cache_read_input_tokens and cache_creation_input_tokens into inputTokens", async () => {
    const { runClaudeStage } = await import("@/server/pipeline/providers/claude");
    queryMock = vi.fn();

    async function* generator() {
      yield { type: "system", subtype: "init", session_id: "sess_cache" };
      yield {
        type: "result",
        subtype: "success",
        session_id: "sess_cache",
        result: "Final answer.",
        total_cost_usd: 0.42,
        num_turns: 3,
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 2_000,
          output_tokens: 500,
        },
      };
    }
    fakeMessages = generator();

    const result = await runClaudeStage({
      role: ROLES.PO_REFINEMENT,
      prompt,
      model: "claude-sonnet-5",
      maxTurns: 10,
      workspacePath: null,
      onEvent: () => {},
    });

    expect(result.inputTokens).toBe(42_011);
    expect(result.cacheReadTokens).toBe(40_000);
    expect(result.cacheWriteTokens).toBe(2_000);
  });

  it("reports 0 cache tokens when the result carries no cache usage fields", async () => {
    const { runClaudeStage } = await import("@/server/pipeline/providers/claude");
    queryMock = vi.fn();

    async function* generator() {
      yield { type: "system", subtype: "init", session_id: "sess_no_cache" };
      yield {
        type: "result",
        subtype: "success",
        session_id: "sess_no_cache",
        result: "Final answer.",
        total_cost_usd: 0.01,
        num_turns: 1,
        usage: { input_tokens: 200, output_tokens: 50 },
      };
    }
    fakeMessages = generator();

    const result = await runClaudeStage({
      role: ROLES.PO_REFINEMENT,
      prompt,
      model: "claude-sonnet-5",
      maxTurns: 10,
      workspacePath: null,
      onEvent: () => {},
    });

    expect(result.inputTokens).toBe(200);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });
});
