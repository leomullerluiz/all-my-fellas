import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ROLES } from "@/server/agents/roles";
import type { StagePromptInput } from "@/server/pipeline/prompt";
import type { GeminiClient } from "@/server/pipeline/providers/gemini";
import { StageAbortedError, StageExecutionError } from "@/server/pipeline/providers/types";

/**
 * S2 — Gemini as a selectable pipeline LLM provider.
 *
 * Same pattern as `run-stage-openai.test.ts`: a fake client injected in
 * place of `@google/genai`'s `models.generateContent`, since there is no
 * live credential or HTTP-mocking library available in this repo.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-stage-gemini-test-"));
const workspacePath = path.join(tempDir, "workspace");
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, "brief.md"), "# Brief\n\nBuild a login form.\n");

let runGeminiStage: typeof import("@/server/pipeline/providers/gemini").runGeminiStage;

const originalKeys = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
});

afterEach(() => {
  restoreEnv();
});

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
  artifacts: [{ type: "brief", content: "Build a login form." }],
  attempt: 1,
};

const STORIES_MD = "## User Stories\n\nAs a user, I can log in.\n";

describe("runGeminiStage", () => {
  it("throws naming the missing credential when GEMINI_API_KEY/GOOGLE_API_KEY are unset", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const { runGeminiStage: run } = await import("@/server/pipeline/providers/gemini");

    await expect(
      run(
        {
          role: ROLES.PO_REFINEMENT,
          prompt,
          model: "gemini-2.5-flash",
          maxTurns: 5,
          workspacePath,
          onEvent: () => {},
        },
        {} as GeminiClient,
      ),
    ).rejects.toThrow(/GEMINI_API_KEY|GOOGLE_API_KEY/);
  });

  it("runs a tool call then returns finalText/costUsd/inputTokens/outputTokens", async () => {
    process.env.GEMINI_API_KEY = "gm-test-123";
    ({ runGeminiStage } = await import("@/server/pipeline/providers/gemini"));

    const events: Array<{ type: string }> = [];
    let call = 0;

    const fakeClient: GeminiClient = {
      models: {
        generateContent: async ({ contents }) => {
          call++;
          if (call === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ functionCall: { name: "Read", args: { file_path: "brief.md" } } }],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
            };
          }

          // Second call: the function response must have been appended.
          expect(contents.some((c) => c.parts.some((p) => p.functionResponse))).toBe(true);
          return {
            candidates: [{ content: { role: "model", parts: [{ text: STORIES_MD }] } }],
            usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
          };
        },
      },
    };

    const result = await runGeminiStage(
      {
        role: ROLES.PO_REFINEMENT,
        prompt,
        model: "gemini-2.5-flash",
        maxTurns: 5,
        workspacePath,
        onEvent: (event) => events.push(event),
      },
      fakeClient,
    );

    expect(result.finalText).toBe(STORIES_MD.trim());
    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(60);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.numTurns).toBe(2);
    expect(events.some((event) => event.type === "agent_tool_use")).toBe(true);
  });

  it("surfaces a StageExecutionError when maxTurns is exhausted without final text", async () => {
    process.env.GEMINI_API_KEY = "gm-test-123";
    ({ runGeminiStage } = await import("@/server/pipeline/providers/gemini"));

    const loopingClient: GeminiClient = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "Read", args: { file_path: "brief.md" } } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      },
    };

    await expect(
      runGeminiStage(
        {
          role: ROLES.PO_REFINEMENT,
          prompt,
          model: "gemini-2.5-flash",
          maxTurns: 2,
          workspacePath,
          onEvent: () => {},
        },
        loopingClient,
      ),
    ).rejects.toThrow(StageExecutionError);
  });

  it("stops on the turn that crosses maxCostUsd, with a non-zero partial and non-retryable", async () => {
    process.env.GEMINI_API_KEY = "gm-test-123";
    ({ runGeminiStage } = await import("@/server/pipeline/providers/gemini"));

    let calls = 0;
    // gemini-2.5-flash: $0.30 / 1M input tokens — 500k input tokens is a
    // fixed $0.15 per turn, so two turns cross a $0.2 ceiling on the second.
    const loopingClient: GeminiClient = {
      models: {
        generateContent: async () => {
          calls++;
          return {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "Read", args: { file_path: "brief.md" } } }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 500_000, candidatesTokenCount: 0 },
          };
        },
      },
    };

    let error: unknown;
    try {
      await runGeminiStage(
        {
          role: ROLES.PO_REFINEMENT,
          prompt,
          model: "gemini-2.5-flash",
          maxTurns: 10,
          maxCostUsd: 0.2,
          workspacePath,
          onEvent: () => {},
        },
        loopingClient,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StageExecutionError);
    const stageError = error as StageExecutionError;
    expect(stageError.retryable).toBe(false);
    expect(stageError.partial.costUsd).toBeGreaterThanOrEqual(0.2);
    expect(stageError.partial.inputTokens).toBe(1_000_000);
    // Stopped before a third turn was ever attempted.
    expect(calls).toBe(2);
  });

  it("stops between turns once the abort signal fires, before the next request is issued", async () => {
    process.env.GEMINI_API_KEY = "gm-test-123";
    ({ runGeminiStage } = await import("@/server/pipeline/providers/gemini"));

    const abortController = new AbortController();
    let calls = 0;

    const loopingClient: GeminiClient = {
      models: {
        generateContent: async () => {
          calls++;
          // Aborted as a side effect of the first turn returning — the
          // between-turns check must catch this before a second request is
          // ever issued.
          abortController.abort();
          return {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "Read", args: { file_path: "brief.md" } } }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          };
        },
      },
    };

    let error: unknown;
    try {
      await runGeminiStage(
        {
          role: ROLES.PO_REFINEMENT,
          prompt,
          model: "gemini-2.5-flash",
          maxTurns: 10,
          workspacePath,
          abortController,
          onEvent: () => {},
        },
        loopingClient,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StageAbortedError);
    expect((error as StageAbortedError).retryable).toBe(false);
    expect(calls).toBe(1);
  });
});
