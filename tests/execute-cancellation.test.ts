import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S4 — an aborted stage run must be recorded as `"cancelled"`, not
 * `"failed"`, carrying whatever partial cost the provider accumulated before
 * the abort landed (§6.5). `execute.ts` is the single place that decides the
 * run's terminal status, so this is exercised there rather than per provider
 * — `tests/claude-cancellation.test.ts`, `run-stage-openai.test.ts` and
 * `run-stage-gemini.test.ts` already cover the provider→`StageAbortedError`
 * half of this; this file covers `StageAbortedError`→`stage_runs` row.
 *
 * `STAKEHOLDER_REFINEMENT` is used throughout, matching
 * `execute-partial-cost.test.ts`: it is text-only (`needsWorkspace: false`),
 * so this reaches `executeAgentStage` without a real git clone.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-cancellation-test-"));
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
    name: "acme/cancellation",
    url: "https://github.com/acme/cancellation",
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
    title: `Cancellation task ${repoCounter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  orchestrator.startTask(task.id);
  const run = service.listStageRuns(task.id).find((candidate) => candidate.stage === "STAKEHOLDER_REFINEMENT")!;
  return { task, run };
}

describe("executeAgentStage — an aborted stage is recorded as cancelled, not failed (S4)", () => {
  it("marks the run 'cancelled' and records the partial cost when the provider throws StageAbortedError", async () => {
    const { task, run } = newStakeholderRun();
    const { StageAbortedError } = await import("@/server/pipeline/providers/types");

    vi.mocked(runStageModule.runStage).mockRejectedValueOnce(
      new StageAbortedError("The Stakeholder session was cancelled.", {
        costUsd: 1.25,
        inputTokens: 400,
        outputTokens: 100,
      }),
    );

    await expect(execute.executeAgentStage(run.id)).rejects.toThrow();

    const cancelled = service.getStageRun(run.id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.costUsd).toBe(1.25);
    expect(cancelled.inputTokens).toBe(400);
    expect(cancelled.outputTokens).toBe(100);
    expect(service.totalCostForTask(task.id)).toBe(1.25);
  });

  it("throws a non-retryable StageJobError so the worker does not re-run the cancelled session", async () => {
    const { run } = newStakeholderRun();
    const { StageAbortedError } = await import("@/server/pipeline/providers/types");
    const { StageJobError } = execute;

    vi.mocked(runStageModule.runStage).mockRejectedValueOnce(
      new StageAbortedError("The Stakeholder session was cancelled."),
    );

    let error: unknown;
    try {
      await execute.executeAgentStage(run.id);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StageJobError);
    expect((error as InstanceType<typeof StageJobError>).retryable).toBe(false);
  });

  it("a plain StageExecutionError (not aborted) still records 'failed', unchanged from S1", async () => {
    const { run } = newStakeholderRun();
    const { StageExecutionError } = await import("@/server/pipeline/providers/types");

    vi.mocked(runStageModule.runStage).mockRejectedValueOnce(new StageExecutionError("a real crash"));

    await expect(execute.executeAgentStage(run.id)).rejects.toThrow();

    const failed = service.getStageRun(run.id)!;
    expect(failed.status).toBe("failed");
  });
});
