import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import simpleGit, { type SimpleGit } from "simple-git";

import { resolveGitIdentity, resolveWorkspacesDir } from "../config/env";
import { slugify } from "../db/ids";
import { remoteGit } from "./client";
import type { GitCredential, RepositoryProvider } from "./providers/types";

/**
 * Per-task git workspace management.
 *
 * Every task gets its own shallow clone under `workspaces/<taskId>`. Agents run
 * with `cwd` pinned there and never receive the credential: it is attached to
 * the clone and push commands the worker issues itself, and the stored remote
 * is always the clean URL.
 *
 * How the credential is attached is the provider's decision — most embed it in
 * the remote URL, Azure DevOps sends an `Authorization` header instead.
 */

export const BRANCH_PREFIX = "pipeline";

export type Workspace = {
  taskId: string;
  /** Absolute path to the clone. */
  path: string;
  branchName: string;
  baseBranch: string;
};

/** Everything a git command needs to authenticate against a remote. */
export type RemoteAccess = {
  provider: RepositoryProvider;
  repoUrl: string;
  credential: GitCredential | null;
};

/**
 * Removes credentials from any string before it reaches a log or the database.
 *
 * Covers both transports: a `user:secret@host` remote, and the base64 blob in
 * an `http.extraHeader` argument that git echoes back in some error messages.
 */
export function redactRemote(message: string): string {
  return message
    .replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, "https://***@")
    .replace(/(Authorization:\s*Basic\s+)\S+/gi, "$1***");
}

export function workspacePathFor(taskId: string): string {
  return path.join(resolveWorkspacesDir(), taskId);
}

/**
 * Whether the clone is still on disk with its git directory intact.
 *
 * Synchronous — checked from inside `retryTask`'s `db.transaction()`, which
 * cannot `await`. `tasks.workspace_path` alone is not trusted: the directory
 * can also vanish by hand, or via a shared-volume `docker compose down -v`,
 * without that column changing.
 */
export function workspaceHasGitDir(taskId: string): boolean {
  return existsSync(path.join(workspacePathFor(taskId), ".git"));
}

export function branchNameFor(taskId: string, title: string): string {
  return `${BRANCH_PREFIX}/${taskId}-${slugify(title)}`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clones the repository and creates the task branch.
 *
 * Idempotent: if the workspace already exists (a retried stage, or a resumed
 * task) the existing clone is reused and the branch is checked out again.
 */
export async function prepareWorkspace(options: {
  taskId: string;
  title: string;
  defaultBranch: string;
  access: RemoteAccess;
  /**
   * A developer-chosen branch name, requested at task creation. Used verbatim
   * (trimmed, no `pipeline/` prefix or task-id suffix) when present; falls
   * back to `branchNameFor(...)` when omitted or blank, exactly as before
   * this option existed.
   */
  customBranchName?: string | null;
}): Promise<Workspace> {
  const target = workspacePathFor(options.taskId);
  const branchName =
    options.customBranchName?.trim() || branchNameFor(options.taskId, options.title);
  const { provider, repoUrl, credential } = options.access;

  if (!(await pathExists(path.join(target, ".git")))) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });

    const transport = provider.transport(repoUrl, credential);
    // `configArgs` denies git any interactive credential fallback, and for
    // header-transport providers also carries the credential. Either way it
    // lives only in this argv.
    await remoteGit().raw([
      ...transport.configArgs,
      "clone",
      "--depth",
      "50",
      "--branch",
      options.defaultBranch,
      transport.url,
      target,
    ]);

    // Store the clean URL so a credential never sits in `.git/config`.
    await simpleGit(target).remote(["set-url", "origin", repoUrl]);
  }

  const git = simpleGit(target);
  const identity = resolveGitIdentity();
  await git.addConfig("user.name", identity.name, false, "local");
  await git.addConfig("user.email", identity.email, false, "local");

  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    await git.checkout(branchName);
  } else {
    await git.checkoutBranch(branchName, `origin/${options.defaultBranch}`);
  }

  return { taskId: options.taskId, path: target, branchName, baseBranch: options.defaultBranch };
}

export function openWorkspace(workspacePath: string): SimpleGit {
  return simpleGit(workspacePath);
}

/** Diff of the task branch against its base, used to brief QA and homologation. */
export async function diffAgainstBase(
  workspacePath: string,
  baseBranch: string,
): Promise<string> {
  const git = simpleGit(workspacePath);
  try {
    return await git.diff([`origin/${baseBranch}...HEAD`]);
  } catch {
    return "";
  }
}

export async function diffStatAgainstBase(
  workspacePath: string,
  baseBranch: string,
): Promise<string> {
  const git = simpleGit(workspacePath);
  try {
    return await git.diff([`origin/${baseBranch}...HEAD`, "--stat"]);
  } catch {
    return "";
  }
}

/**
 * The task branch's current commit SHA.
 *
 * Read before the push at `DELIVERY` (spec-audit-trail.md §8): after the
 * workspace is cleaned up this is the only thing left tying the persisted
 * `diff_summary` artifact to a commit on the remote.
 */
export async function headCommitSha(workspacePath: string): Promise<string> {
  const git = simpleGit(workspacePath);
  const output = await git.raw(["rev-parse", "HEAD"]);
  return output.trim();
}

/** True when the branch has at least one commit the base branch does not. */
export async function hasCommitsAheadOfBase(
  workspacePath: string,
  baseBranch: string,
): Promise<boolean> {
  const git = simpleGit(workspacePath);
  try {
    const output = await git.raw(["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
    return Number.parseInt(output.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Commits anything the Developer left uncommitted.
 *
 * Agents are told to commit their own work, but a half-finished session should
 * not silently drop changes before QA reviews the diff.
 */
export async function commitPendingChanges(
  workspacePath: string,
  message: string,
): Promise<boolean> {
  const git = simpleGit(workspacePath);
  const status = await git.status();
  if (status.isClean()) return false;
  await git.add(["-A"]);
  await git.commit(message);
  return true;
}

/** Pushes the task branch with the credential attached for this command only. */
export async function pushBranch(
  workspacePath: string,
  branchName: string,
  access: RemoteAccess,
): Promise<void> {
  const transport = access.provider.transport(access.repoUrl, access.credential);
  const git = remoteGit(workspacePath);
  try {
    await git.raw([
      ...transport.configArgs,
      "push",
      "--set-upstream",
      transport.url,
      `${branchName}:${branchName}`,
    ]);
  } catch (error) {
    throw new Error(redactRemote(error instanceof Error ? error.message : String(error)));
  }
}

/** Deletes a task workspace. Safe to call when it no longer exists. */
export async function removeWorkspace(taskId: string): Promise<void> {
  await fs.rm(workspacePathFor(taskId), { recursive: true, force: true });
}
