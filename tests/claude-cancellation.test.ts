import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROLES } from "@/server/agents/roles";
import type { StagePromptInput } from "@/server/pipeline/prompt";
import { StageAbortedError } from "@/server/pipeline/providers/types";

/**
 * S4 — Claude's abort plumbing (`abortController` already forwarded into the
 * SDK's own `query()` options) is exercised here, not re-implemented: this
 * covers what `runClaudeStage` does with whatever the SDK does in reaction —
 * a thrown error, or the stream simply ending with no `"result"` message —
 * converting either into a `StageAbortedError` carrying the partial
 * accumulated so far, per §6.5.
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

describe("runClaudeStage — cancellation (S4)", () => {
  it("converts a silently-ended stream into a StageAbortedError once the signal is aborted", async () => {
    const { runClaudeStage } = await import("@/server/pipeline/providers/claude");
    queryMock = vi.fn();

    async function* generator() {
      yield { type: "system", subtype: "init", session_id: "sess_abort" };
      // The stream just ends — no "result" message — which is one of the two
      // shapes an aborted session can take.
    }
    fakeMessages = generator();

    const abortController = new AbortController();
    abortController.abort();

    let error: unknown;
    try {
      await runClaudeStage({
        role: ROLES.PO_REFINEMENT,
        prompt,
        model: "claude-sonnet-5",
        maxTurns: 10,
        workspacePath: null,
        abortController,
        onEvent: () => {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StageAbortedError);
    const aborted = error as StageAbortedError;
    expect(aborted.retryable).toBe(false);
    expect(aborted.partial.sessionId).toBe("sess_abort");
  });

  it("converts a thrown mid-stream error into a StageAbortedError once the signal is aborted", async () => {
    const { runClaudeStage } = await import("@/server/pipeline/providers/claude");
    queryMock = vi.fn();

    const abortController = new AbortController();

    async function* generator() {
      yield { type: "system", subtype: "init", session_id: "sess_abort_2" };
      abortController.abort();
      throw new Error("aborted");
    }
    fakeMessages = generator();

    let error: unknown;
    try {
      await runClaudeStage({
        role: ROLES.PO_REFINEMENT,
        prompt,
        model: "claude-sonnet-5",
        maxTurns: 10,
        workspacePath: null,
        abortController,
        onEvent: () => {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StageAbortedError);
    expect((error as StageAbortedError).partial.sessionId).toBe("sess_abort_2");
  });

  it("does not convert a genuine error into StageAbortedError when the signal was never aborted", async () => {
    const { runClaudeStage } = await import("@/server/pipeline/providers/claude");
    queryMock = vi.fn();

    async function* generator() {
      yield { type: "system", subtype: "init", session_id: "sess_real_error" };
      throw new Error("network blip");
    }
    fakeMessages = generator();

    await expect(
      runClaudeStage({
        role: ROLES.PO_REFINEMENT,
        prompt,
        model: "claude-sonnet-5",
        maxTurns: 10,
        workspacePath: null,
        abortController: new AbortController(),
        onEvent: () => {},
      }),
    ).rejects.toThrow("network blip");
  });
});
