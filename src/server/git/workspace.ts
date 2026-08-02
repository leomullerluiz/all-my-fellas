import fs from "node:fs/promises";
import path from "node:path";

import simpleGit, { type SimpleGit } from "simple-git";

import { readGithubToken, resolveWorkspacesDir } from "../config/env";
import { slugify } from "../db/ids";

/**
 * Per-task git workspace management.
 *
 * Every task gets its own shallow clone under `workspaces/<taskId>`. Agents run
 * with `cwd` pinned there and never receive the GitHub token: it is injected
 * into the remote URL only for the clone and push commands the worker issues
 * itself, and stripped from the stored remote immediately afterwards.
 */

export const BRANCH_PREFIX = "pipeline";

export type Workspace = {
  taskId: string;
  /** Absolute path to the clone. */
  path: string;
  branchName: string;
  baseBranch: string;
};

/** Builds an https remote carrying the PAT. Never persisted or logged. */
function authenticatedUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:") return repoUrl;
    url.username = "x-access-token";
    url.password = token;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/** Removes credentials from any string before it reaches a log or the database. */
export function redactRemote(message: string): string {
  return message.replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, "https://***@");
}

export function workspacePathFor(taskId: string): string {
  return path.join(resolveWorkspacesDir(), taskId);
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
  repoUrl: string;
  defaultBranch: string;
}): Promise<Workspace> {
  const target = workspacePathFor(options.taskId);
  const branchName = branchNameFor(options.taskId, options.title);
  const token = readGithubToken();

  if (!(await pathExists(path.join(target, ".git")))) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });

    const cloner = simpleGit();
    await cloner.clone(authenticatedUrl(options.repoUrl, token), target, [
      "--depth",
      "50",
      "--branch",
      options.defaultBranch,
    ]);

    // Store the clean URL so the token never sits in `.git/config`.
    await simpleGit(target).remote(["set-url", "origin", options.repoUrl]);
  }

  const git = simpleGit(target);
  await git.addConfig("user.name", "Multi-Agent Pipeline", false, "local");
  await git.addConfig("user.email", "pipeline@localhost", false, "local");

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

/** Pushes the task branch with the token injected for this command only. */
export async function pushBranch(
  workspacePath: string,
  repoUrl: string,
  branchName: string,
): Promise<void> {
  const token = readGithubToken();
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set; the pipeline cannot push the task branch.");
  }
  const git = simpleGit(workspacePath);
  try {
    await git.push(authenticatedUrl(repoUrl, token), `${branchName}:${branchName}`, [
      "--set-upstream",
    ]);
  } catch (error) {
    throw new Error(redactRemote(error instanceof Error ? error.message : String(error)));
  }
}

/** Deletes a task workspace. Safe to call when it no longer exists. */
export async function removeWorkspace(taskId: string): Promise<void> {
  await fs.rm(workspacePathFor(taskId), { recursive: true, force: true });
}
