import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { changeRequestNounFor } from "@/lib/provider-copy";

/**
 * The rule: no provider display name, change-request noun, or provider-
 * specific credential variable name may appear as a literal anywhere under
 * `src/`, outside `src/server/git/providers/` — see
 * `spec-execution-honesty.md` §8. A regex over stripped-comment source
 * rather than an AST walk, deliberately: the AST version is exact and
 * roughly ten times the code, modelled on `tests/diff-viewer-safety.test.ts`,
 * which already reads a file, strips comments, and asserts a substring is
 * absent.
 *
 * Comments are exempt (§8) — half the legitimate matches in this codebase are
 * explanations of exactly this rule. Lowercase `ProviderId` values ("github",
 * "gitlab", …) are data, not copy, and are not banned; only the *display*
 * forms are.
 */

const SRC_ROOT = path.resolve(import.meta.dirname, "../src");
const PROVIDERS_DIR = path.resolve(SRC_ROOT, "server/git/providers");

/**
 * The one documented exception (§8): a format example that has to name
 * *something* to illustrate a shape, and asserts nothing about the user's
 * actual provider.
 */
const ALLOWLISTED_CREDENTIAL_VAR_FILES = [path.resolve(SRC_ROOT, "server/git/credentials.ts")];

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Every `.ts`/`.tsx` file under `src/`, excluding the provider modules themselves. */
function sourceFiles(): string[] {
  return walk(SRC_ROOT).filter((file) => !file.startsWith(PROVIDERS_DIR + path.sep));
}

/** Strips block and line comments, matching `diff-viewer-safety.test.ts`'s approach. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const DISPLAY_NAMES = ["GitHub", "GitLab", "Bitbucket", "Azure DevOps"];
const CHANGE_REQUEST_NOUNS = [/pull requests?/i, /merge requests?/i];
const CREDENTIAL_VARS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "AZURE_DEVOPS_TOKEN"];

describe("provider-copy source scan", () => {
  it.each(DISPLAY_NAMES)("bans the display name %s outside providers/", (name) => {
    for (const file of sourceFiles()) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      expect(code, `${name} found in ${path.relative(SRC_ROOT, file)}`).not.toContain(name);
    }
  });

  it.each(CHANGE_REQUEST_NOUNS)("bans %s (case-insensitive, singular or plural) outside providers/", (pattern) => {
    for (const file of sourceFiles()) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      const match = code.match(pattern);
      expect(match, `${pattern} found in ${path.relative(SRC_ROOT, file)}: "${match?.[0]}"`).toBeNull();
    }
  });

  it.each(CREDENTIAL_VARS)("bans the credential variable %s outside providers/ (and its one documented example)", (variable) => {
    for (const file of sourceFiles()) {
      if (ALLOWLISTED_CREDENTIAL_VAR_FILES.includes(file)) continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      expect(code, `${variable} found in ${path.relative(SRC_ROOT, file)}`).not.toContain(variable);
    }
  });

  it("still allows BITBUCKET_TOKEN_ACME as a naming-shape example in credentials.ts", () => {
    const file = ALLOWLISTED_CREDENTIAL_VAR_FILES[0];
    const code = fs.readFileSync(file, "utf8");
    expect(code).toContain("BITBUCKET_TOKEN_ACME");
  });

  it("passes the same banned word appearing only in a comment", () => {
    const source = 'export const x = 1; // Mentions GitLab and "pull request" for humans only.';
    const code = stripComments(source);
    expect(code).not.toContain("GitLab");
    expect(code).not.toMatch(/pull request/i);
  });

  it("passes GitHub's own display name inside providers/github.ts", () => {
    const file = path.resolve(PROVIDERS_DIR, "github.ts");
    const code = stripComments(fs.readFileSync(file, "utf8"));
    // The provider modules are the exception — see §8.
    expect(code).toContain("GitHub");
    expect(code.toLowerCase()).toContain("pull request");
  });

  it("fails on a fixture containing 'GitHub' in a component file", () => {
    const banned = 'export const label = "Open on GitHub";';
    const code = stripComments(banned);
    expect(code).toContain("GitHub");
  });
});

describe("changeRequestNounFor", () => {
  it("returns the shared noun when every provider agrees", () => {
    expect(changeRequestNounFor(["pull request", "pull request"])).toBe("pull request");
  });

  it("returns the neutral term for a mixed set", () => {
    expect(changeRequestNounFor(["pull request", "merge request"])).toBe("change request");
  });

  it("returns the neutral term for an empty set", () => {
    expect(changeRequestNounFor([])).toBe("change request");
  });
});
