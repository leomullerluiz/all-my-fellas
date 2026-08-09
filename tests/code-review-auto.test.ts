import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * S6 — `codeReviewEnabled: auto` skips code review on trivial, low-risk tasks.
 *
 * Exercised at the `advanceTask`/`nextTransition` level: `VERIFICATION`
 * succeeding is the one branch that decides between `CODE_REVIEW` and `QA`,
 * and it needs nothing more than the task's persisted difficulty/criticality
 * and the setting — no agent session involved.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-auto-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

type Service = typeof import("@/server/tasks/service");
type Orchestrator = typeof import("@/server/pipeline/orchestrator");
type Settings = typeof import("@/server/settings/store");

let service: Service;
let orchestrator: Orchestrator;
let settings: Settings;
let repoId: string;
let counter = 0;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  orchestrator = await import("@/server/pipeline/orchestrator");
  settings = await import("@/server/settings/store");

  settings.updateSettings({ maxParallelTasks: 99 });

  repoId = service.createRepo({
    name: "acme/code-review-auto",
    url: "https://github.com/acme/code-review-auto",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function taskAtVerification(
  estimate: { difficulty: "S" | "M" | "L" | null; criticality: "low" | "medium" | "high" | null },
) {
  counter += 1;
  const task = service.createTask({
    repoId,
    title: `Code review auto task ${counter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  service.setTaskEstimate(task.id, estimate.difficulty, estimate.criticality);
  service.setTaskStage(task.id, "VERIFICATION");
  return task;
}

describe("codeReviewEnabled settings validation", () => {
  it("declares codeReviewEnabled so it is not silently stripped by updateSettingsSchema", async () => {
    const { updateSettingsSchema } = await import("@/server/validation/schemas");
    const result = updateSettingsSchema.safeParse({ codeReviewEnabled: "auto" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.codeReviewEnabled).toBe("auto");
  });

  it("defaults to 'always'", async () => {
    const { defaultSettings } = await import("@/server/settings/store");
    expect(defaultSettings().codeReviewEnabled).toBe("always");
  });
});

describe("VERIFICATION -> CODE_REVIEW / QA routing (S6)", () => {
  it("runs CODE_REVIEW by default ('always'), regardless of estimate", () => {
    settings.updateSettings({ codeReviewEnabled: "always" });
    const task = taskAtVerification({ difficulty: "S", criticality: "low" });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "VERIFICATION",
      reviewVerdict: "approved",
    });

    expect(service.getTask(task.id)!.currentStage).toBe("CODE_REVIEW");
  });

  it("'auto' skips CODE_REVIEW straight to QA for an S/low estimate", () => {
    settings.updateSettings({ codeReviewEnabled: "auto" });
    const task = taskAtVerification({ difficulty: "S", criticality: "low" });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "VERIFICATION",
      reviewVerdict: "approved",
    });

    expect(service.getTask(task.id)!.currentStage).toBe("QA");
    expect(service.listStageRuns(task.id).some((run) => run.stage === "CODE_REVIEW")).toBe(false);
  });

  it("'auto' still runs CODE_REVIEW for an M/low estimate", () => {
    settings.updateSettings({ codeReviewEnabled: "auto" });
    const task = taskAtVerification({ difficulty: "M", criticality: "low" });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "VERIFICATION",
      reviewVerdict: "approved",
    });

    expect(service.getTask(task.id)!.currentStage).toBe("CODE_REVIEW");
  });

  it("'auto' still runs CODE_REVIEW for an S/high estimate", () => {
    settings.updateSettings({ codeReviewEnabled: "auto" });
    const task = taskAtVerification({ difficulty: "S", criticality: "high" });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "VERIFICATION",
      reviewVerdict: "approved",
    });

    expect(service.getTask(task.id)!.currentStage).toBe("CODE_REVIEW");
  });

  it("'never' skips CODE_REVIEW unconditionally", () => {
    settings.updateSettings({ codeReviewEnabled: "never" });
    const task = taskAtVerification({ difficulty: "L", criticality: "high" });

    orchestrator.advanceTask(task.id, {
      kind: "stage_succeeded",
      stage: "VERIFICATION",
      reviewVerdict: "approved",
    });

    expect(service.getTask(task.id)!.currentStage).toBe("QA");
  });
});
