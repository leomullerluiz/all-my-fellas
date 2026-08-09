import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S3 — rework cycles carry memory of the previous pass.
 *
 * A real local bare repository (same harness as `tests/workspace-fetch.test.ts`)
 * so `diffAgainstBase`/`diffSince`/`headCommitSha` run as real git commands;
 * only the LLM call (`runStage`) is mocked.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-rework-memory-test-"));
const workspacesDir = path.join(tempDir, "workspaces");
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = workspacesDir;

vi.mock("@/server/pipeline/run-stage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pipeline/run-stage")>();
  return { ...actual, runStage: vi.fn() };
});

type Service = typeof import("@/server/tasks/service");
type Execute = typeof import("@/server/pipeline/execute");
type RunStageModule = typeof import("@/server/pipeline/run-stage");

let service: Service;
let execute: Execute;
let runStageModule: RunStageModule;
let repoId: string;
let originPath: string;

const VALID_CODE_REVIEW = (marker: string) =>
  [
    "## Verdict",
    "",
    "Verdict: approved",
    "",
    "## Summary",
    "",
    `Looks good. ${marker}`,
    "",
    "## Findings",
    "",
    "None.",
    "",
    "## Files Reviewed",
    "",
    "None.",
  ].join("\n");

const VALID_DEV_REPORT = (marker: string) =>
  [
    "## Summary",
    "",
    `Implemented the thing. ${marker}`,
    "",
    "## Changes",
    "",
    "None.",
    "",
    "## Commands Run",
    "",
    "None.",
    "",
    "## Follow-ups",
    "",
    "None.",
  ].join("\n");

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

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  execute = await import("@/server/pipeline/execute");
  runStageModule = await import("@/server/pipeline/run-stage");

  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });

  originPath = path.join(tempDir, "origin.git");
  await simpleGit().init(["--bare", originPath]);

  const seedPath = path.join(tempDir, "seed");
  const seed = simpleGit();
  await seed.clone(originPath, seedPath);
  const seedGit = simpleGit(seedPath);
  await seedGit.addConfig("user.name", "Seed", false, "local");
  await seedGit.addConfig("user.email", "seed@localhost", false, "local");
  await seedGit.checkoutLocalBranch("main");
  fs.writeFileSync(path.join(seedPath, "README.md"), "seed\n");
  await seedGit.add(["README.md"]);
  await seedGit.commit("Initial commit");
  await seedGit.push(["origin", "main"]);

  repoId = service.createRepo({
    name: "acme/rework-memory",
    url: originPath,
    defaultBranch: "main",
    provider: "generic",
  }).id;
}, 30_000);

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Seeds the three artifacts CODE_REVIEW consumes, each behind its own stage run. */
function seedConsumedArtifacts(taskId: string) {
  const poRun = service.createStageRun({ taskId, stage: "PO_REFINEMENT", attempt: 1 });
  service.saveArtifact({
    taskId,
    stageRunId: poRun.id,
    type: "stories",
    contentMd: "## Summary\n\nOk.\n\n## User Stories\n\nNone.\n\n## Out of Scope\n\nNone.",
  });
  const archRun = service.createStageRun({ taskId, stage: "ARCHITECTURE", attempt: 1 });
  service.saveArtifact({
    taskId,
    stageRunId: archRun.id,
    type: "techplan",
    contentMd:
      "## Approach\n\nOk.\n\n## Affected Files\n\nNone.\n\n## Implementation Steps\n\nNone.\n\n## Risks\n\nNone.\n\n## Estimate\n\nDifficulty: S",
  });
  const devRun = service.createStageRun({ taskId, stage: "DEVELOPMENT", attempt: 1 });
  service.saveArtifact({
    taskId,
    stageRunId: devRun.id,
    type: "dev_report",
    contentMd: "## Summary\n\nDone.\n\n## Changes\n\nNone.\n\n## Commands Run\n\nNone.\n\n## Follow-ups\n\nNone.",
  });
}

describe("gatherInputs / execute — rework memory (S3)", () => {
  it(
    "attempt 1 gets the full diff and no incremental supplement; attempt 2 gets both the " +
      "incremental diff and its own previous report",
    async () => {
      const task = service.createTask({
        repoId,
        title: "Rework memory task",
        description: "A description long enough to pass validation upstream.",
        priority: "medium",
      });
      seedConsumedArtifacts(task.id);
      service.setTaskStage(task.id, "CODE_REVIEW");

      const run1 = service.createStageRun({ taskId: task.id, stage: "CODE_REVIEW", attempt: 1 });
      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(
        stageResult(VALID_CODE_REVIEW("REPORT-ONE")),
      );
      await execute.executeAgentStage(run1.id);

      const finishedRun1 = service.getStageRun(run1.id)!;
      expect(finishedRun1.status).toBe("done");
      expect(finishedRun1.userPrompt).toContain("Branch diff against origin/main");
      expect(finishedRun1.userPrompt).not.toContain("Changes since your last review");
      // Recorded on success, so the next attempt can scope its diff to it.
      expect(finishedRun1.reviewedHeadSha).toBeTruthy();

      // Approving CODE_REVIEW just advanced the task to QA (attempt 1) — put
      // it back at CODE_REVIEW to simulate a rework cycle without needing the
      // full QA/rejection round trip through the state machine.
      service.setTaskStage(task.id, "CODE_REVIEW");
      const run2 = service.createStageRun({ taskId: task.id, stage: "CODE_REVIEW", attempt: 2 });
      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(
        stageResult(VALID_CODE_REVIEW("REPORT-TWO")),
      );
      await execute.executeAgentStage(run2.id);

      const finishedRun2 = service.getStageRun(run2.id)!;
      expect(finishedRun2.status).toBe("done");
      expect(finishedRun2.userPrompt).toContain("Changes since your last review");
      expect(finishedRun2.userPrompt).toContain("Branch diff against origin/main");
      // Its own previous verdict, from attempt 1 — not a stale artifact.
      expect(finishedRun2.userPrompt).toContain("REPORT-ONE");
      expect(finishedRun2.reviewedHeadSha).toBeTruthy();
    },
    30_000,
  );

  it("falls back to only the full diff when the previous attempt recorded no SHA", async () => {
    const task = service.createTask({
      repoId,
      title: "Rework memory task without a recorded SHA",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    seedConsumedArtifacts(task.id);
    service.setTaskStage(task.id, "CODE_REVIEW");

    const run1 = service.createStageRun({ taskId: task.id, stage: "CODE_REVIEW", attempt: 1 });
    vi.mocked(runStageModule.runStage).mockResolvedValueOnce(
      stageResult(VALID_CODE_REVIEW("FIRST")),
    );
    await execute.executeAgentStage(run1.id);
    // Simulate a run from before this column existed.
    service.updateStageRun(run1.id, { reviewedHeadSha: null });
    service.setTaskStage(task.id, "CODE_REVIEW");

    const run2 = service.createStageRun({ taskId: task.id, stage: "CODE_REVIEW", attempt: 2 });
    vi.mocked(runStageModule.runStage).mockResolvedValueOnce(
      stageResult(VALID_CODE_REVIEW("SECOND")),
    );
    await expect(execute.executeAgentStage(run2.id)).resolves.toBeUndefined();

    const finishedRun2 = service.getStageRun(run2.id)!;
    expect(finishedRun2.status).toBe("done");
    expect(finishedRun2.userPrompt).not.toContain("Changes since your last review");
    expect(finishedRun2.userPrompt).toContain("Branch diff against origin/main");
  }, 30_000);
});

describe("DEVELOPMENT own-previous report (S3)", () => {
  it(
    "includes the previous dev_report on a rework attempt, not on the first",
    async () => {
      const task = service.createTask({
        repoId,
        title: "Dev rework memory task",
        description: "A description long enough to pass validation upstream.",
        priority: "medium",
      });
      const poRun = service.createStageRun({ taskId: task.id, stage: "PO_REFINEMENT", attempt: 1 });
      service.saveArtifact({
        taskId: task.id,
        stageRunId: poRun.id,
        type: "stories",
        contentMd: "## Summary\n\nOk.\n\n## User Stories\n\nNone.\n\n## Out of Scope\n\nNone.",
      });
      const archRun = service.createStageRun({ taskId: task.id, stage: "ARCHITECTURE", attempt: 1 });
      service.saveArtifact({
        taskId: task.id,
        stageRunId: archRun.id,
        type: "techplan",
        contentMd:
          "## Approach\n\nOk.\n\n## Affected Files\n\nNone.\n\n## Implementation Steps\n\nNone.\n\n" +
          "## Risks\n\nNone.\n\n## Estimate\n\nDifficulty: S",
      });

      service.setTaskStage(task.id, "DEVELOPMENT");

      // `runStage` is mocked, so it never touches the filesystem — a real
      // commit is made here on the task's own branch so the pipeline's
      // post-run `hasCommitsAheadOfBase` check (`no_commits`) still passes.
      const { prepareWorkspace } = await import("@/server/git/workspace");
      const { genericProvider } = await import("@/server/git/providers/generic");
      const workspace = await prepareWorkspace({
        taskId: task.id,
        title: task.title,
        defaultBranch: "main",
        access: { provider: genericProvider, repoUrl: originPath, credential: null },
      });
      const git = simpleGit(workspace.path);
      fs.writeFileSync(path.join(workspace.path, "feature.txt"), "attempt 1\n");
      await git.add(["feature.txt"]);
      await git.commit("Attempt 1 commit");

      const run1 = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(
        stageResult(VALID_DEV_REPORT("DEV-REPORT-ONE")),
      );
      await execute.executeAgentStage(run1.id);

      const finishedRun1 = service.getStageRun(run1.id)!;
      expect(finishedRun1.status).toBe("done");
      expect(finishedRun1.userPrompt).not.toContain("DEV-REPORT-ONE");

      // A CODE_REVIEW rejection sent this back to DEVELOPMENT — restore the
      // stage and add another real commit for the second attempt.
      service.setTaskStage(task.id, "DEVELOPMENT");
      fs.writeFileSync(path.join(workspace.path, "feature2.txt"), "attempt 2\n");
      await git.add(["feature2.txt"]);
      await git.commit("Attempt 2 commit");

      const run2 = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 2 });
      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(
        stageResult(VALID_DEV_REPORT("DEV-REPORT-TWO")),
      );
      await execute.executeAgentStage(run2.id);

      const finishedRun2 = service.getStageRun(run2.id)!;
      expect(finishedRun2.status).toBe("done");
      expect(finishedRun2.userPrompt).toContain("DEV-REPORT-ONE");
    },
    30_000,
  );
});
