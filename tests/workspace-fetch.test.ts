import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * stories.md S2 — `prepareWorkspace` fetches the base branch on every call,
 * not only the first clone, and a fetch failure degrades to a warning
 * instead of failing the stage. Also covers the companion fix: the diff
 * helpers must distinguish "no such ref" (unchanged: no diff) from "the git
 * command itself failed" (surfaced, not silently reported as no diff).
 *
 * Same local-bare-repo harness as `tests/workspace-branch-name.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-fetch-test-"));
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let prepareWorkspace: typeof import("@/server/git/workspace").prepareWorkspace;
let diffAgainstBase: typeof import("@/server/git/workspace").diffAgainstBase;
let diffStatAgainstBase: typeof import("@/server/git/workspace").diffStatAgainstBase;
let hasCommitsAheadOfBase: typeof import("@/server/git/workspace").hasCommitsAheadOfBase;
let genericProvider: typeof import("@/server/git/providers/generic").genericProvider;
let azureDevOpsProvider: typeof import("@/server/git/providers/azure-devops").azureDevOpsProvider;

let originPath: string;
let seedPath: string;

beforeAll(async () => {
  ({ prepareWorkspace, diffAgainstBase, diffStatAgainstBase, hasCommitsAheadOfBase } =
    await import("@/server/git/workspace"));
  ({ genericProvider } = await import("@/server/git/providers/generic"));
  ({ azureDevOpsProvider } = await import("@/server/git/providers/azure-devops"));

  originPath = path.join(tempDir, "origin.git");
  await simpleGit().init(["--bare", originPath]);

  seedPath = path.join(tempDir, "seed");
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

function access(repoUrl = originPath) {
  return { provider: genericProvider, repoUrl, credential: null };
}

describe("prepareWorkspace — fetches the base on every call", () => {
  // Two real clones plus two real fetches, competing with every other file's
  // git child processes under this suite's `maxWorkers: "50%"` — observed to
  // exceed vitest's default 5s test timeout under full-suite contention even
  // though each op is fast in isolation. A longer per-test timeout, not a
  // smaller amount of git work, is the fix.
  it("picks up a commit landed on origin between two calls for the same task", async () => {
    const taskId = "task_fetch_freshness";
    const first = await prepareWorkspace({
      taskId,
      title: "Fetch freshness",
      defaultBranch: "main",
      access: access(),
    });
    const before = (await simpleGit(first.path).raw(["rev-parse", "origin/main"])).trim();

    const seedGit = simpleGit(seedPath);
    fs.writeFileSync(path.join(seedPath, "SECOND.md"), "second\n");
    await seedGit.add(["SECOND.md"]);
    await seedGit.commit("Second commit");
    await seedGit.push(["origin", "main"]);
    const advanced = (await seedGit.raw(["rev-parse", "HEAD"])).trim();
    expect(advanced).not.toBe(before);

    const second = await prepareWorkspace({
      taskId,
      title: "Fetch freshness",
      defaultBranch: "main",
      access: access(),
    });
    expect(second.fetchWarning).toBeUndefined();

    const after = (await simpleGit(second.path).raw(["rev-parse", "origin/main"])).trim();
    expect(after).toBe(advanced);
  }, 20_000);

  // Same contention as above: a clone plus a fetch attempt is fast in
  // isolation but can exceed the default 5s under the full suite's parallel
  // git-heavy files.
  it("does not throw when the fetch fails, and records why on the workspace", async () => {
    const taskId = "task_fetch_failure";
    // First call clones from the real origin, so the workspace exists.
    await prepareWorkspace({
      taskId,
      title: "Fetch failure",
      defaultBranch: "main",
      access: access(),
    });

    // A later call whose remote has gone missing — an offline moment, or a
    // renamed/deleted repository — must not fail the stage.
    const unreachable = path.join(tempDir, "does-not-exist.git");
    const second = await prepareWorkspace({
      taskId,
      title: "Fetch failure",
      defaultBranch: "main",
      access: access(unreachable),
    });

    expect(second.fetchWarning).toBeTruthy();
    // The workspace is still usable: the branch is still checked out.
    const branches = await simpleGit(second.path).branchLocal();
    expect(branches.current).toBe(second.branchName);
  }, 20_000);

  it("never leaves a credential in .git/config, fetch included", async () => {
    const taskId = "task_fetch_no_credential_leak";
    const secret = "SUPER-SECRET-TOKEN";
    const workspace = await prepareWorkspace({
      taskId,
      title: "No credential leak",
      defaultBranch: "main",
      access: {
        // Azure DevOps's transport embeds the credential as a transient
        // `-c http.extraHeader=...` argument regardless of URL scheme —
        // exactly the mechanism a fetch has to keep out of `.git/config`,
        // the same way clone and push already do.
        provider: azureDevOpsProvider,
        repoUrl: originPath,
        credential: { username: "pat", secret },
      },
    });

    const config = fs.readFileSync(path.join(workspace.path, ".git", "config"), "utf8");
    expect(config).not.toContain(secret);
    expect(config).not.toContain("extraHeader");
    expect(config).not.toContain("Authorization");
  }, 20_000);
});

describe("diff helpers distinguish a missing ref from a real command failure", () => {
  it("diffAgainstBase / diffStatAgainstBase / hasCommitsAheadOfBase return the empty case for a base that was never fetched", async () => {
    const taskId = "task_diff_missing_ref";
    const workspace = await prepareWorkspace({
      taskId,
      title: "Missing ref",
      defaultBranch: "main",
      access: access(),
    });

    await expect(diffAgainstBase(workspace.path, "totally-not-a-branch")).resolves.toBe("");
    await expect(diffStatAgainstBase(workspace.path, "totally-not-a-branch")).resolves.toBe("");
    await expect(hasCommitsAheadOfBase(workspace.path, "totally-not-a-branch")).resolves.toBe(
      false,
    );
  }, 20_000);

  it("surfaces a real git command failure instead of reporting it as no diff", async () => {
    // Not a git repository at all — every command genuinely fails, which is
    // not the same thing as "that ref does not exist".
    const notARepo = path.join(tempDir, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });

    await expect(diffAgainstBase(notARepo, "main")).rejects.toThrow();
    await expect(diffStatAgainstBase(notARepo, "main")).rejects.toThrow();
    await expect(hasCommitsAheadOfBase(notARepo, "main")).rejects.toThrow();
  });
});
