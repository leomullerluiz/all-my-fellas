import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `workspaceIsDirty`, against a real git repository (S3).
 *
 * A dirty working tree is not part of the diff shown at `HUMAN_CODE_REVIEW`
 * and would otherwise be silently lost — this is the check that detects it.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-status-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

const repoDir = path.join(tempDir, "repo");

let workspace: typeof import("@/server/git/workspace");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

beforeAll(async () => {
  workspace = await import("@/server/git/workspace");

  fs.mkdirSync(repoDir, { recursive: true });
  git("init", "--initial-branch=main", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  fs.writeFileSync(path.join(repoDir, "keep.txt"), "one\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("workspaceIsDirty", () => {
  it("reports clean for an untouched checkout", async () => {
    await expect(workspace.workspaceIsDirty(repoDir)).resolves.toBe(false);
  });

  it("reports dirty once a file is modified", async () => {
    fs.writeFileSync(path.join(repoDir, "keep.txt"), "one\ntwo\n");
    await expect(workspace.workspaceIsDirty(repoDir)).resolves.toBe(true);
    // Restore for the tests below.
    git("checkout", "--", "keep.txt");
  });

  it("reports dirty for an untracked file", async () => {
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "surprise\n");
    await expect(workspace.workspaceIsDirty(repoDir)).resolves.toBe(true);
    fs.rmSync(path.join(repoDir, "untracked.txt"));
  });

  it("fails safe (null) when the directory does not exist", async () => {
    await expect(
      workspace.workspaceIsDirty(path.join(tempDir, "does-not-exist")),
    ).resolves.toBeNull();
  });

  it("fails safe (null) when the directory exists but has no .git", async () => {
    const notARepo = path.join(tempDir, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    await expect(workspace.workspaceIsDirty(notARepo)).resolves.toBeNull();
  });
});
