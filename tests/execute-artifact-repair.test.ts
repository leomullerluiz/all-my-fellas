import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S4 — a malformed artifact gets one bounded repair attempt instead of dying
 * outright.
 *
 * `STAKEHOLDER_REFINEMENT` throughout: text-only (`needsWorkspace: false`,
 * `consumes: []`), so this reaches the validation/repair path in
 * `executeAgentStage` without a real git clone — the same shortcut
 * `execute-prompt-capture.test.ts` takes.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-artifact-repair-test-"));
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
let counter = 0;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  orchestrator = await import("@/server/pipeline/orchestrator");
  execute = await import("@/server/pipeline/execute");
  runStageModule = await import("@/server/pipeline/run-stage");

  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });

  repoId = service.createRepo({
    name: "acme/artifact-repair",
    url: "https://github.com/acme/artifact-repair",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(runStageModule.runStage).mockReset();
});

function newStakeholderRun() {
  counter += 1;
  const task = service.createTask({
    repoId,
    title: `Repair task ${counter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  orchestrator.startTask(task.id);
  const run = service.listStageRuns(task.id).find((candidate) => candidate.stage === "STAKEHOLDER_REFINEMENT")!;
  return { task, run };
}

function stageResult(finalText: string) {
  return {
    sessionId: null,
    finalText,
    costUsd: 0.01,
    inputTokens: 10,
    outputTokens: 5,
    numTurns: 1,
    transcript: [],
  };
}

const MISSING_SECTION_BRIEF = [
  "## Business Intent",
  "",
  "Do the thing.",
  "",
  "## Value",
  "",
  "Saves time.",
  // "## Constraints", "## Restated Requirement" and "## Open Questions" missing.
].join("\n");

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

describe("executeAgentStage — bounded artifact repair (S4)", () => {
  it("makes no repair turn and incurs no extra cost when the first output already validates", async () => {
    const { run } = newStakeholderRun();

    vi.mocked(runStageModule.runStage).mockResolvedValueOnce(stageResult(VALID_BRIEF));

    await execute.executeAgentStage(run.id);

    expect(runStageModule.runStage).toHaveBeenCalledTimes(1);
    const finished = service.getStageRun(run.id)!;
    expect(finished.status).toBe("done");
    expect(finished.costUsd).toBeCloseTo(0.01);
    expect(finished.rejectedOutput).toBeNull();
  });

  it("repairs a missing-section document in one extra turn and advances with the repaired content", async () => {
    const { task, run } = newStakeholderRun();

    vi.mocked(runStageModule.runStage)
      .mockResolvedValueOnce(stageResult(MISSING_SECTION_BRIEF))
      .mockResolvedValueOnce(stageResult(VALID_BRIEF));

    await execute.executeAgentStage(run.id);

    expect(runStageModule.runStage).toHaveBeenCalledTimes(2);
    // The repair call named the exact missing sections, not the compression
    // instruction, which is a different string entirely.
    const repairCallArgs = vi.mocked(runStageModule.runStage).mock.calls[1][1];
    const repairPromptBody = JSON.stringify(repairCallArgs.prompt.supplements);
    expect(repairPromptBody).toContain("missing required section");
    expect(repairPromptBody).not.toContain("Compress it to fit under the");

    const finished = service.getStageRun(run.id)!;
    expect(finished.status).toBe("done");
    expect(finished.rejectedOutput).toBeNull();

    const artifact = service.latestArtifact(task.id, "brief");
    expect(artifact).not.toBeNull();
    expect(artifact!.contentMd).toContain("Restated Requirement");
  });

  it("adds the repair turn's cost to the stage run rather than overwriting the first call's", async () => {
    const { run } = newStakeholderRun();

    vi.mocked(runStageModule.runStage)
      .mockResolvedValueOnce({ ...stageResult(MISSING_SECTION_BRIEF), costUsd: 0.01, inputTokens: 10, outputTokens: 5 })
      .mockResolvedValueOnce({ ...stageResult(VALID_BRIEF), costUsd: 0.02, inputTokens: 20, outputTokens: 8 });

    await execute.executeAgentStage(run.id);

    const finished = service.getStageRun(run.id)!;
    expect(finished.costUsd).toBeCloseTo(0.03);
    expect(finished.inputTokens).toBe(30);
    expect(finished.outputTokens).toBe(13);
  });

  it("fails the stage, not retryable, when the repair attempt's output still does not validate", async () => {
    const { run } = newStakeholderRun();

    vi.mocked(runStageModule.runStage)
      .mockResolvedValueOnce(stageResult(MISSING_SECTION_BRIEF))
      .mockResolvedValueOnce(stageResult(MISSING_SECTION_BRIEF));

    await expect(execute.executeAgentStage(run.id)).rejects.toMatchObject({
      retryable: false,
      kind: "artifact_invalid",
    });

    expect(runStageModule.runStage).toHaveBeenCalledTimes(2);
    const finished = service.getStageRun(run.id)!;
    expect(finished.status).toBe("failed");
    // The repair's own output is what gets kept — it is the last thing the
    // agent produced.
    expect(finished.rejectedOutput).toBe(MISSING_SECTION_BRIEF);
  });

  it("keeps the original rejected text when the repair call itself fails to run", async () => {
    const { run } = newStakeholderRun();
    const { StageExecutionError } = await import("@/server/pipeline/providers/types");

    vi.mocked(runStageModule.runStage)
      .mockResolvedValueOnce(stageResult(MISSING_SECTION_BRIEF))
      .mockRejectedValueOnce(new StageExecutionError("repair session errored"));

    await expect(execute.executeAgentStage(run.id)).rejects.toMatchObject({
      retryable: false,
      kind: "artifact_invalid",
    });

    const finished = service.getStageRun(run.id)!;
    expect(finished.status).toBe("failed");
    expect(finished.rejectedOutput).toBe(MISSING_SECTION_BRIEF);
  });

  it("sends the compression instruction, not the missing-section one, for an over-length document", async () => {
    const { run } = newStakeholderRun();

    const overLength = `${VALID_BRIEF}\n${"x".repeat(41_000)}`;
    vi.mocked(runStageModule.runStage)
      .mockResolvedValueOnce(stageResult(overLength))
      .mockResolvedValueOnce(stageResult(VALID_BRIEF));

    await execute.executeAgentStage(run.id);

    const repairCallArgs = vi.mocked(runStageModule.runStage).mock.calls[1][1];
    const repairPromptBody = JSON.stringify(repairCallArgs.prompt.supplements);
    expect(repairPromptBody).toContain("Compress it to fit under the");
    expect(repairPromptBody).not.toContain("The document is missing required structure");
  });
});
