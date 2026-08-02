import { spawn } from "node:child_process";

import { readGithubToken } from "../config/env";
import { redactRemote } from "./workspace";

/**
 * Pull request creation via the GitHub CLI.
 *
 * `gh` runs as a child of the worker with `GH_TOKEN` in its environment, so the
 * credential never enters an agent session. When `gh` is unavailable the
 * pipeline still succeeds — the branch is pushed and the user gets a compare
 * link to open the PR manually.
 */

export type PullRequestResult =
  | { status: "created"; url: string }
  | { status: "manual"; url: string; reason: string };

type CommandResult = { code: number; stdout: string; stderr: string };

function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const token = readGithubToken();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GH_TOKEN: token ?? "", GH_PROMPT_DISABLED: "1" },
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Builds the GitHub "open a PR" URL used when `gh` is not installed. */
export function compareUrl(repoUrl: string, baseBranch: string, branchName: string): string {
  const normalized = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
  return `${normalized}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(
    branchName,
  )}?expand=1`;
}

export async function ghAvailable(cwd: string): Promise<boolean> {
  try {
    const result = await run("gh", ["--version"], cwd);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function createPullRequest(options: {
  workspacePath: string;
  repoUrl: string;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
}): Promise<PullRequestResult> {
  const fallback = compareUrl(options.repoUrl, options.baseBranch, options.branchName);

  if (!readGithubToken()) {
    return { status: "manual", url: fallback, reason: "GITHUB_TOKEN is not configured." };
  }
  if (!(await ghAvailable(options.workspacePath))) {
    return {
      status: "manual",
      url: fallback,
      reason: "The GitHub CLI (`gh`) was not found on PATH.",
    };
  }

  const result = await run(
    "gh",
    [
      "pr",
      "create",
      "--base",
      options.baseBranch,
      "--head",
      options.branchName,
      "--title",
      options.title,
      "--body",
      options.body,
    ],
    options.workspacePath,
  );

  if (result.code === 0) {
    const url = /https:\/\/\S+/.exec(result.stdout)?.[0];
    if (url) return { status: "created", url };
  }

  return {
    status: "manual",
    url: fallback,
    reason: redactRemote((result.stderr || result.stdout).trim()) || "`gh pr create` failed.",
  };
}

/** Verifies a repository is reachable, used when registering a connection. */
export async function verifyRepositoryAccess(
  repoUrl: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = readGithubToken();
  if (!token) return { ok: false, reason: "GITHUB_TOKEN is not configured." };

  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoUrl);
  if (!match) return { ok: false, reason: "Only github.com repository URLs are supported." };

  try {
    const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "multi-agent-pipeline",
      },
    });
    if (response.ok) return { ok: true };
    return { ok: false, reason: `GitHub returned ${response.status} ${response.statusText}.` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
