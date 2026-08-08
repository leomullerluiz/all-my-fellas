import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S2 — repository conventions reach every provider.
 *
 * A real local bare repository (same harness as `tests/workspace-fetch.test.ts`)
 * so the workspace actually has `CLAUDE.md`/`AGENTS.md` on disk for
 * `loadProjectContext` to read; only the LLM call (`runStage`) is mocked.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-project-context-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

vi.mock("@/server/pipeline/run-stage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pipeline/run-stage")>();
  return { ...actual, runStage: vi.fn() };
});

type Service = typeof import("@/server/tasks/service");
type Execute = typeof import("@/server/pipeline/execute");
type RunStageModule = typeof import("@/server/pipeline/run-stage");
type SettingsModule = typeof import("@/server/settings/store");

let service: Service;
let execute: Execute;
let runStageModule: RunStageModule;
let settings: SettingsModule;
let repoId: string;
let seedPath: string;
let counter = 0;

const VALID_TECHPLAN = [
  "## Approach",
  "",
  "Ok.",
  "",
  "## Affected Files",
  "",
  "None.",
  "",
  "## Implementation Steps",
  "",
  "None.",
  "",
  "## Risks",
  "",
  "None.",
  "",
  "## Estimate",
  "",
  "Difficulty: S",
  "Criticality: low",
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
  settings = await import("@/server/settings/store");

  settings.updateSettings({ maxParallelTasks: 99 });

  const originPath = path.join(tempDir, "origin.git");
  await simpleGit().init(["--bare", originPath]);

  seedPath = path.join(tempDir, "seed");
  const seed = simpleGit();
  await seed.clone(originPath, seedPath);
  const seedGit = simpleGit(seedPath);
  await seedGit.addConfig("user.name", "Seed", false, "local");
  await seedGit.addConfig("user.email", "seed@localhost", false, "local");
  await seedGit.checkoutLocalBranch("main");
  fs.writeFileSync(path.join(seedPath, "CLAUDE.md"), "claude content");
  await seedGit.add(["CLAUDE.md"]);
  await seedGit.commit("Initial commit");
  await seedGit.push(["origin", "main"]);

  repoId = service.createRepo({
    name: "acme/project-context",
    url: originPath,
    defaultBranch: "main",
    provider: "generic",
  }).id;
}, 20_000);

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** A task parked at ARCHITECTURE, with its `consumes` already satisfied. */
function taskAtArchitecture() {
  counter += 1;
  const task = service.createTask({
    repoId,
    title: `Project context task ${counter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  const stakeholderRun = service.createStageRun({ taskId: task.id, stage: "STAKEHOLDER_REFINEMENT", attempt: 1 });
  service.saveArtifact({
    taskId: task.id,
    stageRunId: stakeholderRun.id,
    type: "brief",
    contentMd:
      "## Business Intent\n\nOk.\n\n## Value\n\nOk.\n\n## Constraints\n\nNone.\n\n" +
      "## Restated Requirement\n\nOk.\n\n## Open Questions\n\nNone.",
  });
  const poRun = service.createStageRun({ taskId: task.id, stage: "PO_REFINEMENT", attempt: 1 });
  service.saveArtifact({
    taskId: task.id,
    stageRunId: poRun.id,
    type: "stories",
    contentMd: "## Summary\n\nOk.\n\n## User Stories\n\nNone.\n\n## Out of Scope\n\nNone.",
  });
  service.setTaskStage(task.id, "ARCHITECTURE");
  return task;
}

describe("execute.ts — project context wiring (S2)", () => {
  it(
    "does not duplicate CLAUDE.md as a supplement on the Claude path (the SDK already loads it)",
    async () => {
      settings.updateSettings({ providers: { ARCHITECTURE: "claude" } });
      const task = taskAtArchitecture();
      const run = service.createStageRun({ taskId: task.id, stage: "ARCHITECTURE", attempt: 1 });

      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(stageResult(VALID_TECHPLAN));
      await execute.executeAgentStage(run.id);

      const finished = service.getStageRun(run.id)!;
      expect(finished.status).toBe("done");
      expect(finished.userPrompt).not.toContain("Repository conventions");
    },
    30_000,
  );

  it(
    "injects CLAUDE.md as a supplement on a non-Claude provider",
    async () => {
      settings.updateSettings({ providers: { ARCHITECTURE: "chatgpt" } });
      const task = taskAtArchitecture();
      const run = service.createStageRun({ taskId: task.id, stage: "ARCHITECTURE", attempt: 1 });

      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(stageResult(VALID_TECHPLAN));
      await execute.executeAgentStage(run.id);

      const finished = service.getStageRun(run.id)!;
      expect(finished.status).toBe("done");
      expect(finished.userPrompt).toContain("Repository conventions");
      expect(finished.userPrompt).toContain("claude content");
    },
    30_000,
  );

  it(
    "prefers AGENTS.md over CLAUDE.md, and injects it even on the Claude path",
    async () => {
      const seedGit = simpleGit(seedPath);
      fs.writeFileSync(path.join(seedPath, "AGENTS.md"), "agents content");
      await seedGit.add(["AGENTS.md"]);
      await seedGit.commit("Add AGENTS.md");
      await seedGit.push(["origin", "main"]);

      settings.updateSettings({ providers: { ARCHITECTURE: "claude" } });
      const task = taskAtArchitecture();
      const run = service.createStageRun({ taskId: task.id, stage: "ARCHITECTURE", attempt: 1 });

      vi.mocked(runStageModule.runStage).mockResolvedValueOnce(stageResult(VALID_TECHPLAN));
      await execute.executeAgentStage(run.id);

      const finished = service.getStageRun(run.id)!;
      expect(finished.status).toBe("done");
      expect(finished.userPrompt).toContain("Repository conventions");
      expect(finished.userPrompt).toContain("agents content");
      expect(finished.userPrompt).not.toContain("claude content");
    },
    30_000,
  );
});
