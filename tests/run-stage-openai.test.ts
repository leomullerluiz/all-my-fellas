import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ROLES } from "@/server/agents/roles";
import type { StagePromptInput } from "@/server/pipeline/prompt";
import type { OpenAiChatClient, OpenAiMessage } from "@/server/pipeline/providers/openai";
import { StageExecutionError } from "@/server/pipeline/providers/types";

/**
 * S1 — ChatGPT as a selectable pipeline LLM provider.
 *
 * The real OpenAI wire format is not exercised here (no network access in
 * CI); a fake client injected in place of the SDK's own `chat.completions`
 * stands in for it, per the tech plan's injectable-client pattern.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-stage-openai-test-"));
const workspacePath = path.join(tempDir, "workspace");
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, "brief.md"), "# Brief\n\nBuild a login form.\n");

let runOpenAiStage: typeof import("@/server/pipeline/providers/openai").runOpenAiStage;

const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

afterEach(() => {
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
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

describe("runOpenAiStage", () => {
  it("throws naming OPENAI_API_KEY when the credential is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const { runOpenAiStage: run } = await import("@/server/pipeline/providers/openai");

    await expect(
      run(
        {
          role: ROLES.PO_REFINEMENT,
          prompt,
          model: "gpt-4o-mini",
          maxTurns: 5,
          workspacePath,
          onEvent: () => {},
        },
        {} as OpenAiChatClient,
      ),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("runs a tool call then returns finalText/costUsd/inputTokens/outputTokens", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    ({ runOpenAiStage } = await import("@/server/pipeline/providers/openai"));

    const events: Array<{ type: string }> = [];
    let call = 0;

    const fakeClient: OpenAiChatClient = {
      chat: {
        completions: {
          create: async ({ messages }) => {
            call++;
            if (call === 1) {
              const message: OpenAiMessage = {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "Read", arguments: JSON.stringify({ file_path: "brief.md" }) },
                  },
                ],
              };
              return {
                choices: [{ message, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
              };
            }

            // Second call: the tool result must have been appended.
            expect(messages.some((m) => m.role === "tool")).toBe(true);
            const message: OpenAiMessage = { role: "assistant", content: STORIES_MD };
            return {
              choices: [{ message, finish_reason: "stop" }],
              usage: { prompt_tokens: 150, completion_tokens: 40 },
            };
          },
        },
      },
    };

    const result = await runOpenAiStage(
      {
        role: ROLES.PO_REFINEMENT,
        prompt,
        model: "gpt-4o-mini",
        maxTurns: 5,
        workspacePath,
        onEvent: (event) => events.push(event),
      },
      fakeClient,
    );

    expect(result.finalText).toBe(STORIES_MD);
    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(60);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.numTurns).toBe(2);
    expect(events.some((event) => event.type === "agent_tool_use")).toBe(true);
  });

  it("surfaces a StageExecutionError when maxTurns is exhausted without final text", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    ({ runOpenAiStage } = await import("@/server/pipeline/providers/openai"));

    const loopingClient: OpenAiChatClient = {
      chat: {
        completions: {
          create: async () => {
            const message: OpenAiMessage = {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: { name: "Read", arguments: JSON.stringify({ file_path: "brief.md" }) },
                },
              ],
            };
            return {
              choices: [{ message, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          },
        },
      },
    };

    await expect(
      runOpenAiStage(
        {
          role: ROLES.PO_REFINEMENT,
          prompt,
          model: "gpt-4o-mini",
          maxTurns: 2,
          workspacePath,
          onEvent: () => {},
        },
        loopingClient,
      ),
    ).rejects.toThrow(StageExecutionError);
  });
});
