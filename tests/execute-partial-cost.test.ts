import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S1 — a stage run that throws with a populated `partial` must record the
 * spend it actually incurred, even when the throw carried no transcript
 * growth (a budget stop or a between-turn abort with no new message since
 * the last successful turn). See stories.md S1 / spec §5.4.
 *
 * `STAKEHOLDER_REFINEMENT` is used throughout: it is text-only
 * (`needsWorkspace: false`, `consumes: []`), so this reaches `executeAgentStage`
 * without a real git clone. `runStage` is mocked so the test controls the
 * `StageExecutionError` path deterministically.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-partial-cost-test-"));
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
    name: "acme/partial-cost",
    url: "https://github.com/acme/partial-cost",
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
    title: `Partial cost task ${repoCounter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  orchestrator.startTask(task.id);
  const run = service.listStageRuns(task.id).find((candidate) => candidate.stage === "STAKEHOLDER_REFINEMENT")!;
  return { task, run };
}

describe("executeAgentStage — partial cost is recorded on failure (S1)", () => {
  it("records non-zero cost/tokens when the thrown partial carries them, with no transcript", async () => {
    const { task, run } = newStakeholderRun();
    const { StageExecutionError } = await import("@/server/pipeline/providers/types");

    vi.mocked(runStageModule.runStage).mockRejectedValueOnce(
      new StageExecutionError("budget stop", {
        costUsd: 2.5,
        inputTokens: 1000,
        outputTokens: 500,
        // Deliberately no `transcript` — the exact gap this test targets.
      }),
    );

    await expect(execute.executeAgentStage(run.id)).rejects.toThrow();

    const failed = service.getStageRun(run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.costUsd).toBe(2.5);
    expect(failed.inputTokens).toBe(1000);
    expect(failed.outputTokens).toBe(500);

    // `totalCostForTask`/`costSince` read the same `stage_runs.cost_usd`
    // column — no new aggregation path to keep in sync.
    expect(service.totalCostForTask(task.id)).toBe(2.5);
  });

  it("still records $0 when the thrown partial is empty, unchanged from today", async () => {
    const { task, run } = newStakeholderRun();
    const { StageExecutionError } = await import("@/server/pipeline/providers/types");

    vi.mocked(runStageModule.runStage).mockRejectedValueOnce(new StageExecutionError("no partial at all"));

    await expect(execute.executeAgentStage(run.id)).rejects.toThrow();

    const failed = service.getStageRun(run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.costUsd).toBe(0);
    expect(failed.inputTokens).toBe(0);
    expect(failed.outputTokens).toBe(0);
    expect(service.totalCostForTask(task.id)).toBe(0);
  });
});
