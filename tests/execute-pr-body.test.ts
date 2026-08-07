import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `buildPullRequestBody`'s `## Verification` section — spec §12: expanded
 * (not inside a `<details>`), a table when commands ran, and a stated
 * paragraph when nothing was configured.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-pr-body-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

type Service = typeof import("@/server/tasks/service");
type Execute = typeof import("@/server/pipeline/execute");

let service: Service;
let execute: Execute;
let repoCounter = 0;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  execute = await import("@/server/pipeline/execute");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newTask() {
  repoCounter += 1;
  const repo = service.createRepo({
    name: `acme/pr-body-${repoCounter}`,
    url: `https://github.com/acme/pr-body-${repoCounter}`,
    defaultBranch: "main",
  });
  return service.createTask({
    repoId: repo.id,
    title: `PR body task ${repoCounter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

describe("buildPullRequestBody — ## Verification section", () => {
  it("states plainly that nothing was run mechanically when no VERIFICATION run exists", () => {
    const task = newTask();

    const body = execute.buildPullRequestBody(task.id, task.title);

    expect(body).toContain("## Verification");
    expect(body).toContain("nothing was run mechanically");
    // Expanded, not tucked inside a collapsed <details> block.
    const verificationIndex = body.indexOf("## Verification");
    const nextDetailsIndex = body.indexOf("<details>", verificationIndex);
    const nextHeadingIndex = body.indexOf("##", verificationIndex + 1);
    expect(nextDetailsIndex === -1 || nextDetailsIndex > nextHeadingIndex).toBe(true);
  });

  it("renders a command/result/duration table when the repository has verification rows", () => {
    const task = newTask();
    const run = service.createStageRun({ taskId: task.id, stage: "VERIFICATION", attempt: 1 });
    service.markStageRunStatus(run.id, "done");
    service.saveVerificationRuns(task.id, run.id, [
      {
        kind: "install",
        command: "npm ci",
        exitCode: 0,
        timedOut: false,
        durationMs: 41_000,
        stdoutTail: "",
        stderrTail: "",
      },
      {
        kind: "build",
        command: "npm run build",
        exitCode: 0,
        timedOut: false,
        durationMs: 72_000,
        stdoutTail: "",
        stderrTail: "",
      },
    ]);

    const body = execute.buildPullRequestBody(task.id, task.title);

    expect(body).toContain("## Verification");
    expect(body).toContain("| Command | Result | Duration |");
    expect(body).toContain("`npm ci`");
    expect(body).toContain("`npm run build`");
    expect(body).toContain("✅ exit 0");
  });
});
