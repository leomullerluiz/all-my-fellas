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
  /**
   * Set when the pre-stage fetch of `baseBranch` failed. The workspace is
   * still usable — the stage proceeds against whatever `origin/<baseBranch>`
   * last resolved to — but the diff a reviewer sees may be stale. See
   * stories.md S2.
   */
  fetchWarning?: string;
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
  // `configArgs` denies git any interactive credential fallback, and for
  // header-transport providers also carries the credential. Either way it
  // lives only in this argv.
  const transport = provider.transport(repoUrl, credential);

  if (!(await pathExists(path.join(target, ".git")))) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });

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

  // Fetched on every call, not only the first clone (spec-delivery-lifecycle
  // §4.2): every diff in the product is computed against `origin/<base>`, and
  // a clone left untouched since `PO_REFINEMENT` means every later stage —
  // including the reviewer's — reads a base frozen at that moment. A failure
  // here is not fatal: an offline moment should not fail a stage whose work is
  // otherwise fine, so the stage proceeds against the last known base and the
  // caller is told, via `fetchWarning`, to record that it did.
  let fetchWarning: string | undefined;
  try {
    // An explicit refspec, not just the branch name: fetching by URL rather
    // than by the `origin` remote's name means git has no configured refspec
    // to fall back on, and without one this would only update `FETCH_HEAD` —
    // leaving `origin/<defaultBranch>`, which every diff in the product reads,
    // exactly as stale as before the fetch ran.
    await remoteGit(target).raw([
      ...transport.configArgs,
      "fetch",
      "--depth",
      "50",
      transport.url,
      // `+` forces the update even when it is not a fast-forward — the same
      // as the refspec a normal `clone` configures for `origin` — so a
      // rewritten upstream base does not leave the fetch silently failing.
      `+${options.defaultBranch}:refs/remotes/origin/${options.defaultBranch}`,
    ]);
  } catch (error) {
    fetchWarning = redactRemote(error instanceof Error ? error.message : String(error));
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

  return {
    taskId: options.taskId,
    path: target,
    branchName,
    baseBranch: options.defaultBranch,
    fetchWarning,
  };
}

export function openWorkspace(workspacePath: string): SimpleGit {
  return simpleGit(workspacePath);
}

/**
 * Whether a git failure means "that ref does not exist" rather than "the
 * command itself failed".
 *
 * `diffAgainstBase`, `diffStatAgainstBase` and `hasCommitsAheadOfBase` all
 * treat a missing ref as "no diff" / "no commits" — a workspace whose base
 * branch was never fetched genuinely has nothing to compare against. Any
 * other failure (a corrupt repository, a permissions error, git itself not
 * being on `PATH`) must not collapse into the same silent "no changes":
 * QA's `extractReviewVerdict` fails closed on an artifact claiming no
 * changes were made, so a swallowed command failure here would be read as a
 * real, reviewable "nothing changed" — see spec-delivery-lifecycle.md §11.2.
 *
 * This matches git's *English* error text. A server running with a
 * non-English `LANG`/`LC_ALL` would localise these messages and defeat the
 * match, reclassifying a real command failure as "no such ref" — the
 * opposite of what this function exists to guard against. Pinning the child
 * process to the `C` locale was tried and reverted: passing
 * `{...process.env, LC_ALL: "C"}` to simple-git's `.env()` replaces
 * `_executor.env` wholesale, which trips simple-git's own
 * `blockUnsafeOperationsPlugin` the moment the inherited environment happens
 * to contain a var it treats as a command-injection vector (e.g. `EDITOR`) —
 * turning a locale fix into a hard failure on exactly the hosts it was meant
 * to help. Deployment is expected to run with an English locale (the
 * project's own tooling and error messages are all English); revisit with a
 * narrower env-scoping mechanism if that stops being true.
 */
function isNoSuchRefError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown revision|bad revision|ambiguous argument/i.test(message);
}

function rethrowCommandFailure(error: unknown): never {
  throw new Error(redactRemote(error instanceof Error ? error.message : String(error)));
}

/** Diff of the task branch against its base, used to brief QA and homologation. */
export async function diffAgainstBase(
  workspacePath: string,
  baseBranch: string,
): Promise<string> {
  const git = simpleGit(workspacePath);
  try {
    return await git.diff([`origin/${baseBranch}...HEAD`]);
  } catch (error) {
    if (isNoSuchRefError(error)) return "";
    rethrowCommandFailure(error);
  }
}

export async function diffStatAgainstBase(
  workspacePath: string,
  baseBranch: string,
): Promise<string> {
  const git = simpleGit(workspacePath);
  try {
    return await git.diff([`origin/${baseBranch}...HEAD`, "--stat"]);
  } catch (error) {
    if (isNoSuchRefError(error)) return "";
    rethrowCommandFailure(error);
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
  } catch (error) {
    if (isNoSuchRefError(error)) return false;
    rethrowCommandFailure(error);
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

/**
 * Whether the workspace has uncommitted changes.
 *
 * `null` means "cannot tell" — the workspace directory is missing (already
 * cleaned up, or the task never reached a stage that needs one) or the git
 * command itself failed. Both are treated as "nothing to warn about" by the
 * caller rather than an error: a reviewer must never be blocked by a check
 * that only exists to warn them, and a `false` here would be actively wrong
 * (a workspace that does not exist is not "clean").
 */
export async function workspaceIsDirty(workspacePath: string): Promise<boolean | null> {
  if (!existsSync(path.join(workspacePath, ".git"))) return null;
  try {
    const status = await simpleGit(workspacePath).status();
    return !status.isClean();
  } catch {
    return null;
  }
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
