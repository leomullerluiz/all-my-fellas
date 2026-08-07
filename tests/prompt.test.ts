import { describe, expect, it } from "vitest";

import { ROLES } from "@/server/agents/roles";
import { AGENT_STAGES } from "@/server/pipeline/stages";
import { buildStagePrompt, type StagePromptInput } from "@/server/pipeline/prompt";

/**
 * `buildStagePrompt` — covers the "## Repository context" section: present
 * and placed right after "## Task" when the repo has context, omitted
 * entirely when it does not, and rendered the same way regardless of role
 * (the field lives on shared task data, with no per-role filtering).
 */

const BASE_TASK: StagePromptInput["task"] = {
  id: "task_1",
  title: "Login form",
  description: "As a user I want to log in.",
  priority: "medium",
  repoName: "acme/app",
  repoContext: null,
  branchName: "task/login-form",
};

function prompt(overrides: Partial<StagePromptInput["task"]> = {}): StagePromptInput {
  return {
    role: ROLES.ARCHITECTURE,
    task: { ...BASE_TASK, ...overrides },
    artifacts: [],
    attempt: 1,
  };
}

describe("buildStagePrompt — repository context", () => {
  it("includes the section right after ## Task when context is set", () => {
    const output = buildStagePrompt(
      prompt({ repoContext: "Modular monolith. Business logic lives under src/server." }),
    );

    const taskIndex = output.indexOf("## Task");
    const contextIndex = output.indexOf("## Repository context");
    const requestIndex = output.indexOf("## Original request");

    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeGreaterThan(taskIndex);
    expect(requestIndex).toBeGreaterThan(contextIndex);
    expect(output).toContain(
      "## Repository context\n\nModular monolith. Business logic lives under src/server.",
    );
  });

  it("omits the section entirely when context is null", () => {
    const output = buildStagePrompt(prompt({ repoContext: null }));
    expect(output).not.toContain("## Repository context");
  });

  it("omits the section entirely when context is an empty string", () => {
    const output = buildStagePrompt(prompt({ repoContext: "" }));
    expect(output).not.toContain("## Repository context");
  });

  it("produces the same output for a null-context prompt regardless of context field being present", () => {
    const withField = buildStagePrompt(prompt({ repoContext: null }));
    const built = buildStagePrompt({
      role: ROLES.ARCHITECTURE,
      task: BASE_TASK,
      artifacts: [],
      attempt: 1,
    });
    expect(withField).toBe(built);
  });

  it("renders the section for every role, not just Architect/Developer", () => {
    const repoContext = "Follow the existing service-layer pattern.";
    for (const stage of AGENT_STAGES) {
      const output = buildStagePrompt({
        role: ROLES[stage],
        task: { ...BASE_TASK, repoContext },
        artifacts: [],
        attempt: 1,
      });
      expect(output).toContain(`## Repository context\n\n${repoContext}`);
    }
  });
});
