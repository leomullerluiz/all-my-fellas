import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveWorkspacesDir } from "../config/env";
import type { VerificationKind } from "../events/store";
import { remoteGit } from "./client";
import { connectionContext, type RepoConnection } from "./pull-request";
import { redactRemote } from "./workspace";

/**
 * Autodetection of a repository's install/build/test/lint commands, run once
 * at connection time (spec §5.2).
 *
 * Detection never saves anything — the caller only offers the result as
 * `suggestedCommands`, prefilled into the form. A stored command is always a
 * human action, taken through `PATCH /api/repos/:id`.
 */

export type SuggestedCommands = Partial<Record<VerificationKind, string>>;

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJsonScripts(root: string): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return null;
  }
}

/** Target names declared in a Makefile — a `^name:` line, not just the file's presence. */
async function makefileTargets(root: string): Promise<Set<string>> {
  const targets = new Set<string>();
  try {
    const raw = await fs.readFile(path.join(root, "Makefile"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
      if (match) targets.add(match[1]);
    }
  } catch {
    // No Makefile — an empty set correctly suggests nothing.
  }
  return targets;
}

/**
 * Reads a cloned repository's manifests and suggests commands.
 *
 * A JavaScript command is offered only when the matching key exists in
 * `package.json`'s `scripts`; a `Makefile` command only when the target is
 * declared. Detection failure for one ecosystem never blocks another — each
 * check degrades independently to "no suggestion".
 */
export async function detectVerificationCommands(root: string): Promise<SuggestedCommands> {
  const suggestions: SuggestedCommands = {};

  const scripts = await readPackageJsonScripts(root);
  if (scripts) {
    let install: string | null = null;
    let run: ((script: string) => string) | null = null;

    if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
      install = "pnpm install --frozen-lockfile";
      run = (script) => `pnpm ${script}`;
    } else if (await pathExists(path.join(root, "package-lock.json"))) {
      install = "npm ci";
      run = (script) => (script === "test" ? "npm test" : `npm run ${script}`);
    } else if (await pathExists(path.join(root, "yarn.lock"))) {
      install = "yarn install --frozen-lockfile";
      run = (script) => `yarn ${script}`;
    }

    if (install && run) {
      suggestions.install = install;
      if (scripts.build) suggestions.build = run("build");
      if (scripts.test) suggestions.test = run("test");
      if (scripts.lint) suggestions.lint = run("lint");
    }
  }

  if (!suggestions.install && (await pathExists(path.join(root, "go.mod")))) {
    suggestions.install = "go mod download";
    suggestions.build ??= "go build ./...";
    suggestions.test ??= "go test ./...";
    suggestions.lint ??= "go vet ./...";
  }

  if (await pathExists(path.join(root, "Cargo.toml"))) {
    suggestions.build ??= "cargo build";
    suggestions.test ??= "cargo test";
    suggestions.lint ??= "cargo clippy";
  }

  if (await pathExists(path.join(root, "pyproject.toml"))) {
    const hasLock = await pathExists(path.join(root, "poetry.lock"));
    if (hasLock) {
      suggestions.install ??= "poetry install";
      suggestions.test ??= "poetry run pytest";
      suggestions.lint ??= "poetry run ruff check .";
    } else {
      suggestions.install ??= "pip install -e .";
      suggestions.test ??= "pytest";
      suggestions.lint ??= "ruff check .";
    }
  }

  const targets = await makefileTargets(root);
  if (targets.has("build")) suggestions.build ??= "make build";
  if (targets.has("test")) suggestions.test ??= "make test";
  if (targets.has("lint")) suggestions.lint ??= "make lint";

  return suggestions;
}

/**
 * Clones `connection` into a throwaway temp directory, detects its commands,
 * and always removes the clone before returning.
 *
 * Never throws: a clone that fails (private repo, offline host, unparsable
 * URL) is not an error for the connection request — it just means no
 * suggestions, with the reason left for the caller to report.
 */
export async function detectVerificationCommandsForRepo(
  connection: RepoConnection,
): Promise<{ suggestions: SuggestedCommands; reason?: string }> {
  const target = path.join(resolveWorkspacesDir(), `.detect-${randomUUID()}`);
  try {
    const context = connectionContext(connection);
    if (!context.credential && connection.credentialRef) {
      return { suggestions: {}, reason: "No credential is configured for this repository." };
    }

    const transport = context.provider.transport(connection.url, context.credential);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await remoteGit().raw([
      ...transport.configArgs,
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--branch",
      connection.defaultBranch,
      transport.url,
      target,
    ]);

    const suggestions = await detectVerificationCommands(target);
    return { suggestions };
  } catch (error) {
    return {
      suggestions: {},
      reason: redactRemote(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
}
