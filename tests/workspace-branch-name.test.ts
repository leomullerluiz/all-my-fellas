import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * S2's git-checkout-level acceptance criterion: `prepareWorkspace` actually
 * checks out a developer-chosen `customBranchName`, and falls back to
 * `branchNameFor(...)` exactly as before when none is given.
 *
 * There is no remote git server in this test suite, so a local bare
 * repository stands in for `origin`. `genericProvider.transport` builds the
 * same `urlTransport` every other provider uses; with `credential: null` a
 * non-`https://` URL (a plain filesystem path here, which git treats the
 * same as a `file://` remote) passes through untouched — see
 * `providers/generic.ts` and `urlTransport` in `providers/types.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-branch-test-"));
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let prepareWorkspace: typeof import("@/server/git/workspace").prepareWorkspace;
let branchNameFor: typeof import("@/server/git/workspace").branchNameFor;
let genericProvider: typeof import("@/server/git/providers/generic").genericProvider;
let slugify: typeof import("@/server/db/ids").slugify;

let originPath: string;

beforeAll(async () => {
  ({ prepareWorkspace, branchNameFor } = await import("@/server/git/workspace"));
  ({ genericProvider } = await import("@/server/git/providers/generic"));
  ({ slugify } = await import("@/server/db/ids"));

  // A bare repo to act as `origin`.
  originPath = path.join(tempDir, "origin.git");
  await simpleGit().init(["--bare", originPath]);

  // Seed it with a `main` branch and one commit, the way a real repo would
  // already have one before the pipeline ever clones it.
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
}, 20_000);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function access() {
  return { provider: genericProvider, repoUrl: originPath, credential: null };
}

describe("prepareWorkspace — custom branch name", () => {
  // Each case here clones from the real bare origin — fast in isolation, but
  // observed to exceed vitest's default 5s timeout under full-suite
  // contention with every other file's git child processes (same fix as
  // `tests/workspace-fetch.test.ts`).
  it("checks out the exact custom branch name, untouched", async () => {
    const taskId = "task_custom_branch";
    const workspace = await prepareWorkspace({
      taskId,
      title: "Some feature",
      defaultBranch: "main",
      access: access(),
      customBranchName: "feature/my-custom-name",
    });

    expect(workspace.branchName).toBe("feature/my-custom-name");

    const git = simpleGit(workspace.path);
    const branches = await git.branchLocal();
    expect(branches.current).toBe("feature/my-custom-name");
    expect(branches.all).toContain("feature/my-custom-name");
  }, 20_000);

  it("trims surrounding whitespace before checking out", async () => {
    const taskId = "task_custom_branch_trim";
    const workspace = await prepareWorkspace({
      taskId,
      title: "Some feature",
      defaultBranch: "main",
      access: access(),
      customBranchName: "  feature/trimmed  ",
    });

    expect(workspace.branchName).toBe("feature/trimmed");
    const git = simpleGit(workspace.path);
    expect((await git.branchLocal()).current).toBe("feature/trimmed");
  }, 20_000);

  it("falls back to branchNameFor(...) when omitted", async () => {
    const taskId = "task_no_custom_branch";
    const title = "Some feature";
    const workspace = await prepareWorkspace({
      taskId,
      title,
      defaultBranch: "main",
      access: access(),
    });

    const expected = branchNameFor(taskId, title);
    expect(expected).toBe(`pipeline/${taskId}-${slugify(title)}`);
    expect(workspace.branchName).toBe(expected);

    const git = simpleGit(workspace.path);
    expect((await git.branchLocal()).current).toBe(expected);
  }, 20_000);

  it("falls back to branchNameFor(...) when the custom name is blank/whitespace-only", async () => {
    const taskId = "task_blank_custom_branch";
    const title = "Some feature";
    const workspace = await prepareWorkspace({
      taskId,
      title,
      defaultBranch: "main",
      access: access(),
      customBranchName: "   ",
    });

    expect(workspace.branchName).toBe(branchNameFor(taskId, title));
  }, 20_000);
});
