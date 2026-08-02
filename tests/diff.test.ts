import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Diff reading, against a real git repository.
 *
 * Parsing `--name-status -z` and `--numstat -z` has enough edge cases —
 * renames, binaries, NUL framing — that mocking git would only test the mock.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

const repoDir = path.join(tempDir, "repo");

let diff: typeof import("@/server/git/diff");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

function write(relative: string, contents: string | Buffer): void {
  const target = path.join(repoDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

beforeAll(async () => {
  diff = await import("@/server/git/diff");

  fs.mkdirSync(repoDir, { recursive: true });
  git("init", "--initial-branch=main", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  write("keep.txt", "one\ntwo\nthree\n");
  write("remove-me.txt", "gone soon\n");
  write("rename-me.txt", "stable contents that will move\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");

  // `readDiffIndex` diffs against `origin/<base>`, so give it that ref without
  // needing a real remote.
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  git("checkout", "--quiet", "-b", "feature");
  write("keep.txt", "one\ntwo modified\nthree\nfour\n");
  write("added.txt", "brand new\n");
  fs.rmSync(path.join(repoDir, "remove-me.txt"));
  git("mv", "rename-me.txt", "renamed.txt");
  write("logo.bin", Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  git("add", "-A");
  git("commit", "--quiet", "-m", "change everything");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("readDiffIndex", () => {
  it("reports the right status for every kind of change", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    const byPath = new Map(index.files.map((file) => [file.path, file]));

    expect(byPath.get("added.txt")).toMatchObject({ status: "added" });
    expect(byPath.get("keep.txt")).toMatchObject({ status: "modified" });
    expect(byPath.get("remove-me.txt")).toMatchObject({ status: "deleted" });
    expect(byPath.get("renamed.txt")).toMatchObject({
      status: "renamed",
      oldPath: "rename-me.txt",
    });
  });

  it("counts additions and deletions", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    const keep = index.files.find((file) => file.path === "keep.txt")!;

    expect(keep.additions).toBe(2);
    expect(keep.deletions).toBe(1);
    expect(index.totalAdditions).toBeGreaterThan(0);
  });

  it("flags binary files instead of counting lines", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    const binary = index.files.find((file) => file.path === "logo.bin")!;

    expect(binary.binary).toBe(true);
    expect(binary.additions).toBe(0);
    expect(binary.deletions).toBe(0);
  });

  it("does not misattribute counts across a rename", async () => {
    // The rename record carries two paths in numstat; attributing its counts to
    // the source path would leave the destination showing 0/0.
    const index = await diff.readDiffIndex(repoDir, "main");
    expect(index.files.some((file) => file.path === "rename-me.txt")).toBe(false);
    expect(index.files.find((file) => file.path === "renamed.txt")).toBeDefined();
  });

  it("summarises the change set", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    expect(diff.summarizeDiff(index)).toMatch(/^\d+ files changed, \+\d+ −\d+$/);
  });
});

describe("GET /api/tasks/:id/diff", () => {
  let route: typeof import("@/app/api/tasks/[id]/diff/route");
  let service: typeof import("@/server/tasks/service");
  let taskId: string;

  beforeAll(async () => {
    route = await import("@/app/api/tasks/[id]/diff/route");
    service = await import("@/server/tasks/service");

    const repo = service.createRepo({
      name: "acme/app",
      url: "https://github.com/acme/app",
      defaultBranch: "main",
    });
    const task = service.createTask({
      repoId: repo.id,
      title: "Diffable",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    service.updateTask(task.id, { workspacePath: repoDir });
    taskId = task.id;
  });

  function get(query = "") {
    return route.GET(new Request(`http://test/api/tasks/${taskId}/diff${query}`), {
      params: Promise.resolve({ id: taskId }),
    });
  }

  it("returns the file index", async () => {
    const response = await get();
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      available: boolean;
      files: Array<{ path: string }>;
    };
    expect(payload.available).toBe(true);
    expect(payload.files.map((file) => file.path)).toContain("keep.txt");
  });

  it("returns a patch for a file in the index", async () => {
    const response = await get("?file=keep.txt");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { patch: string };
    expect(payload.patch).toContain("+two modified");
  });

  it("refuses any path that is not in this task's diff", async () => {
    // The allowlist is a computed set, not a parsed string, so traversal,
    // absolute paths and option-looking paths are all rejected by the same rule.
    const hostile = [
      "../../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "--output=/tmp/pwned",
      "-o/tmp/pwned",
      "keep.txt/../../../secret",
      "unchanged-file.txt",
      "",
    ];

    for (const file of hostile) {
      const response = await get(`?file=${encodeURIComponent(file)}`);
      expect(response.status, `path ${JSON.stringify(file)} must be refused`).toBe(400);
    }
  });

  it("reports unavailability instead of failing when there is no workspace", async () => {
    const repo = service.listRepos()[0];
    const task = service.createTask({
      repoId: repo.id,
      title: "No workspace",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    const response = await route.GET(new Request("http://test"), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { available: boolean; reason: string };
    expect(payload.available).toBe(false);
    expect(payload.reason).toMatch(/workspace/i);
  });

  it("returns 404 for an unknown task", async () => {
    const response = await route.GET(new Request("http://test"), {
      params: Promise.resolve({ id: "task_missing" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("readFilePatch", () => {
  it("returns a unified diff for a modified file", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    const file = index.files.find((entry) => entry.path === "keep.txt")!;
    const patch = await diff.readFilePatch(repoDir, "main", file);

    expect(patch.binary).toBe(false);
    expect(patch.patch).toContain("@@");
    expect(patch.patch).toContain("+two modified");
    expect(patch.patch).toContain("-two");
  });

  it("returns no patch for a binary file", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    const file = index.files.find((entry) => entry.path === "logo.bin")!;
    const patch = await diff.readFilePatch(repoDir, "main", file);

    expect(patch.binary).toBe(true);
    expect(patch.patch).toBe("");
  });

  it("includes both sides of a rename", async () => {
    const index = await diff.readDiffIndex(repoDir, "main");
    const file = index.files.find((entry) => entry.path === "renamed.txt")!;
    const patch = await diff.readFilePatch(repoDir, "main", file);

    expect(patch.patch).toContain("rename-me.txt");
    expect(patch.patch).toContain("renamed.txt");
  });
});
