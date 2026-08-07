import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S1 — prompt, model, provider and partial-transcript capture.
 *
 * `STAKEHOLDER_REFINEMENT` is used throughout: it is text-only
 * (`needsWorkspace: false`, `consumes: []`), so this reaches `executeAgentStage`
 * without a real git clone. `runStage` is mocked so the test controls both the
 * success and the `StageExecutionError` path deterministically.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-prompt-capture-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

vi.mock("@/server/pipeline/run-stage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pipeline/run-stage")>();
  return { ...actual, runStage: vi.fn() };
});

type Service = typeof import("@/server/tasks/service");
type Orchestrator = typeof import("@/server/pipeline/orchestrator");
type Execute = typeof import("@/server/pipeline/execute");
type RunStageModule = typeof import("@/server/pipeline/run-stage");

let service: Service;
let orchestrator: Orchestrator;
let execute: Execute;
let runStageModule: RunStageModule;
let repoId: string;
let repoCounter = 0;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  orchestrator = await import("@/server/pipeline/orchestrator");
  execute = await import("@/server/pipeline/execute");
  runStageModule = await import("@/server/pipeline/run-stage");

  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });

  repoId = service.createRepo({
    name: "acme/prompt-capture",
    url: "https://github.com/acme/prompt-capture",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newStakeholderRun() {
  repoCounter += 1;
  const task = service.createTask({
    repoId,
    title: `Prompt capture task ${repoCounter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  orchestrator.startTask(task.id);
  const run = service.listStageRuns(task.id).find((candidate) => candidate.stage === "STAKEHOLDER_REFINEMENT")!;
  return { task, run };
}

const VALID_BRIEF = [
  "## Business Intent",
  "",
  "Do the thing.",
  "",
  "## Value",
  "",
  "Saves time.",
  "",
  "## Constraints",
  "",
  "None.",
  "",
  "## Restated Requirement",
  "",
  "Do the thing well.",
  "",
  "## Open Questions",
  "",
  "None.",
].join("\n");

describe("executeAgentStage — prompt capture (S1)", () => {
  it("persists system/user prompt, model and provider before the provider runs", async () => {
    const { run } = newStakeholderRun();

    vi.mocked(runStageModule.runStage).mockResolvedValueOnce({
      sessionId: "sess_1",
      finalText: VALID_BRIEF,
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 5,
      numTurns: 1,
      transcript: [{ type: "result", subtype: "success", result: "ok" }],
    });

    await execute.executeAgentStage(run.id);

    const updated = service.getStageRun(run.id)!;
    expect(updated.systemPrompt).not.toBeNull();
    expect(updated.systemPrompt).toContain("Output contract");
    expect(updated.userPrompt).not.toBeNull();
    expect(updated.userPrompt).toContain("Prompt capture task");
    expect(updated.model).not.toBeNull();
    expect(updated.provider).toBe("claude");
  });

  it("keeps the partial transcript and token counts when the provider throws, and marks the run failed", async () => {
    const { run } = newStakeholderRun();
    const { StageExecutionError } = await import("@/server/pipeline/providers/types");

    vi.mocked(runStageModule.runStage).mockRejectedValueOnce(
      new StageExecutionError("boom", {
        sessionId: "sess_2",
        inputTokens: 42,
        outputTokens: 7,
        costUsd: 0.02,
        transcript: [{ type: "result", subtype: "error_max_turns" }],
      }),
    );

    await expect(execute.executeAgentStage(run.id)).rejects.toThrow();

    const failed = service.getStageRun(run.id)!;
    expect(failed.status).toBe("failed");
    // The prompt was persisted before the provider was ever invoked, so it
    // survives even though the run itself failed.
    expect(failed.systemPrompt).not.toBeNull();
    expect(failed.userPrompt).not.toBeNull();
    expect(failed.inputTokens).toBe(42);
    expect(failed.outputTokens).toBe(7);

    const agentRun = service.latestAgentRun(run.id);
    expect(agentRun).not.toBeNull();
    expect(agentRun?.sessionId).toBe("sess_2");
    const stored = JSON.parse(agentRun!.transcriptJson) as unknown[];
    expect(stored).toHaveLength(1);
  });

  it("leaves a run that never calls runStage (e.g. DELIVERY) with all four columns null", () => {
    const task = service.createTask({
      repoId,
      title: "Delivery-shaped task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    const run = service.createStageRun({ taskId: task.id, stage: "DELIVERY", attempt: 1 });

    expect(run.systemPrompt).toBeNull();
    expect(run.userPrompt).toBeNull();
    expect(run.model).toBeNull();
    expect(run.provider).toBeNull();
  });
});
