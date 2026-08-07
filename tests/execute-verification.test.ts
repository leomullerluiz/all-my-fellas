import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `executeVerification` end to end, against a real SQLite file and real
 * (Node one-liner) child processes — no LLM call involved, unlike the other
 * stage executors, so this is directly testable rather than mocked.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-verification-test-"));
const workspacesDir = path.join(tempDir, "workspaces");
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = workspacesDir;

type Service = typeof import("@/server/tasks/service");
type Execute = typeof import("@/server/pipeline/execute");

let service: Service;
let execute: Execute;
let repoCounter = 0;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  execute = await import("@/server/pipeline/execute");

  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function node(script: string): string {
  return `"${process.execPath}" -e '${script}'`;
}

/** Creates a repo + task already parked at VERIFICATION with a real workspace dir. */
function setUpAtVerification(commands: {
  verifyInstall?: string;
  verifyBuild?: string;
  verifyTest?: string;
  verifyLint?: string;
}) {
  repoCounter += 1;
  const repo = service.createRepo({
    name: `acme/app-${repoCounter}`,
    url: `https://github.com/acme/app-${repoCounter}`,
    defaultBranch: "main",
  });
  service.updateRepoVerificationCommands(repo.id, commands);

  const task = service.createTask({
    repoId: repo.id,
    title: `Task ${repoCounter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });

  const workspacePath = path.join(workspacesDir, task.id);
  fs.mkdirSync(workspacePath, { recursive: true });
  service.setTaskStage(task.id, "VERIFICATION");
  service.updateTask(task.id, { workspacePath });

  const run = service.createStageRun({ taskId: task.id, stage: "VERIFICATION", attempt: 1 });
  return { task, run, repo };
}

describe("executeVerification", () => {
  it("skips with zero rows and advances the task to CODE_REVIEW when no commands are configured", async () => {
    const { task, run } = setUpAtVerification({});

    await execute.executeVerification(run.id);

    expect(service.getTask(task.id)!.currentStage).toBe("CODE_REVIEW");
    expect(service.listVerificationRuns(task.id)).toHaveLength(0);

    const artifact = service.latestArtifact(task.id, "verification_report");
    expect(artifact).not.toBeNull();
    expect(artifact!.contentMd).toContain("Skipped");
  });

  it("advances to CODE_REVIEW and persists one row per command when everything passes", async () => {
    const { task, run } = setUpAtVerification({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(0)"),
      verifyTest: node("process.exit(0)"),
      verifyLint: node("process.exit(0)"),
    });

    await execute.executeVerification(run.id);

    expect(service.getTask(task.id)!.currentStage).toBe("CODE_REVIEW");
    const rows = service.listVerificationRuns(task.id);
    expect(rows.map((r) => r.kind)).toEqual(["install", "build", "test", "lint"]);
    expect(rows.every((r) => r.exitCode === 0)).toBe(true);
  });

  it("sends work back to DEVELOPMENT — not CODE_REVIEW — when build fails, with only two rows", async () => {
    const { task, run } = setUpAtVerification({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(1)"),
      verifyTest: node("process.exit(0)"),
      verifyLint: node("process.exit(0)"),
    });

    await execute.executeVerification(run.id);

    expect(service.getTask(task.id)!.currentStage).toBe("DEVELOPMENT");
    const rows = service.listVerificationRuns(task.id);
    expect(rows.map((r) => r.kind)).toEqual(["install", "build"]);
  });

  it("throws a retryable StageJobError on a red install, and never advances the task", async () => {
    const { task, run } = setUpAtVerification({ verifyInstall: node("process.exit(1)") });

    await expect(execute.executeVerification(run.id)).rejects.toMatchObject({
      name: "StageJobError",
      retryable: true,
    });

    // Never a rework signal: the task stays put for the worker's ordinary
    // retry/backoff, not sent to DEVELOPMENT as if it were a code failure.
    expect(service.getTask(task.id)!.currentStage).toBe("VERIFICATION");
    const stageRun = service.getStageRun(run.id)!;
    expect(stageRun.status).toBe("failed");
  });

  it("produces a verification_report artifact whose Commands section names the failing command", async () => {
    const { task, run } = setUpAtVerification({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(0)"),
      verifyTest: node("process.exit(1)"),
      verifyLint: node("process.exit(0)"),
    });

    await execute.executeVerification(run.id);

    const artifact = service.latestArtifact(task.id, "verification_report");
    expect(artifact!.contentMd).toContain("## Outcome");
    expect(artifact!.contentMd).toContain("## Commands");
    expect(artifact!.contentMd).toContain("## Output");
    expect(artifact!.contentMd).toContain("Failed");
  });

  it("names the failing command in the task's failureReason once the rework budget is exhausted", async () => {
    const { task, run } = setUpAtVerification({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(1)"),
    });

    // Three prior DEVELOPMENT runs exhausts the default two-cycle budget
    // (reworkOrFail fails once developmentAttempts > reworkMaxCycles).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt });
    }

    await execute.executeVerification(run.id);

    const finished = service.getTask(task.id)!;
    expect(finished.currentStage).toBe("FAILED");
    // Not the generic "Verification failed" alone — the command and its exit
    // code, per spec §9.1's worked example.
    expect(finished.failureReason).toContain("`" + node("process.exit(1)") + "`");
    expect(finished.failureReason).toContain("exited 1");
    expect(finished.failureReason).toContain("rework budget");
  });

  it("keeps verification_runs rows after the workspace is deleted (executeCleanup)", async () => {
    const { task, run } = setUpAtVerification({ verifyInstall: node("process.exit(0)") });
    await execute.executeVerification(run.id);
    expect(service.listVerificationRuns(task.id)).toHaveLength(1);

    await execute.executeCleanup(task.id);

    expect(service.getTask(task.id)!.workspacePath).toBeNull();
    // The audit record outlives the clone — that is the point (spec §6.4).
    expect(service.listVerificationRuns(task.id)).toHaveLength(1);
  });
});
