import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `diff_summary` is written at `DELIVERY`, before the push — S4 /
 * spec-audit-trail.md §8. Uses a real git repository, like `tests/diff.test.ts`:
 * parsing/writing against a real clone is what the write path actually does.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-delivery-diff-summary-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");
// No GITHUB_TOKEN: `pushBranch` fails at credential resolution, before any
// network call — exactly the "push fails" case this test wants without a
// real remote.
delete process.env.GITHUB_TOKEN;

const repoDir = path.join(tempDir, "repo");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

type Service = typeof import("@/server/tasks/service");
type Execute = typeof import("@/server/pipeline/execute");

let service: Service;
let execute: Execute;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  execute = await import("@/server/pipeline/execute");

  fs.mkdirSync(repoDir, { recursive: true });
  git("init", "--initial-branch=main", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "keep.txt"), "one\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  git("checkout", "--quiet", "-b", "pipeline/task-delivery");
  fs.writeFileSync(path.join(repoDir, "keep.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "change");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newDeliveryRun() {
  const repo = service.createRepo({
    name: "acme/delivery-diff-summary",
    url: "https://github.com/acme/delivery-diff-summary",
    defaultBranch: "main",
  });
  const task = service.createTask({
    repoId: repo.id,
    title: "Delivery diff summary task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  service.updateTask(task.id, {
    workspacePath: repoDir,
    branchName: "pipeline/task-delivery",
  });
  const run = service.createStageRun({ taskId: task.id, stage: "DELIVERY", attempt: 1 });
  return { task, run };
}

describe("executeDelivery — diff_summary artifact", () => {
  it("writes diff_summary before the push, and it survives when the push fails", async () => {
    const { task, run } = newDeliveryRun();

    await expect(execute.executeDelivery(run.id)).rejects.toThrow();

    const failed = service.getStageRun(run.id)!;
    expect(failed.status).toBe("failed");

    const artifact = service.latestArtifact(task.id, "diff_summary");
    expect(artifact).not.toBeNull();
    expect(artifact!.contentMd).toContain("## Summary");
    expect(artifact!.contentMd).toContain("## Files");
    expect(artifact!.contentMd).toContain("keep.txt");
    expect(artifact!.contentMd).toContain("Base branch");
  });
});
