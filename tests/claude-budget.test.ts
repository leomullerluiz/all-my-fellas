import { describe, expect, it } from "vitest";

import { ROLES } from "@/server/agents/roles";
import { buildOptions } from "@/server/pipeline/providers/claude";
import type { RunStageOptions } from "@/server/pipeline/providers/types";
import type { StagePromptInput } from "@/server/pipeline/prompt";

/**
 * S3 — `buildOptions` forwards the per-stage spend ceiling to the Claude
 * Agent SDK's own `maxBudgetUsd`, and omits it entirely when none is
 * configured (the SDK option itself is optional for exactly that case).
 */

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

function baseOptions(overrides: Partial<RunStageOptions> = {}): RunStageOptions {
  return {
    role: ROLES.PO_REFINEMENT,
    prompt,
    model: "claude-sonnet-5",
    maxTurns: 12,
    workspacePath: null,
    onEvent: () => {},
    ...overrides,
  };
}

describe("claude buildOptions — spend ceiling (S3)", () => {
  it("includes maxBudgetUsd when a stage ceiling is configured", () => {
    const built = buildOptions(baseOptions({ maxCostUsd: 2.5 }));
    expect(built.maxBudgetUsd).toBe(2.5);
  });

  it("omits maxBudgetUsd when no ceiling is configured", () => {
    const built = buildOptions(baseOptions({ maxCostUsd: undefined }));
    expect(built.maxBudgetUsd).toBeUndefined();
  });
});
