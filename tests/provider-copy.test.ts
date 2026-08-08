import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

const DISPLAY_NAMES = ["GitHub", "GitLab", "Bitbucket", "Azure DevOps"];
const CHANGE_REQUEST_NOUNS = [/pull requests?/i, /merge requests?/i];
const CREDENTIAL_VARS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "AZURE_DEVOPS_TOKEN"];

/**
 * The one documented exception (§8): a format example that has to name
 * *something* to illustrate a shape, and asserts nothing about the user's
 * actual provider. Relative to whatever root is being scanned.
 */
const CREDENTIAL_VAR_ALLOWLIST = ["server/git/credentials.ts"];

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

/** Strips block and line comments, matching `diff-viewer-safety.test.ts`'s approach. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

type Violation = { file: string; match: string };

/**
 * Walks every `.ts`/`.tsx` file under `root`, excluding `providersDir` (the
 * abstraction itself) and `CREDENTIAL_VAR_ALLOWLIST`, and reports every banned
 * literal found in stripped-comment source. This is the scanner the CI check
 * runs — `sourceScanViolations` below runs it against the real tree, and the
 * fixture tests run it against a throwaway directory to prove it actually
 * catches a regression rather than trivially passing.
 */
function scanTree(root: string, providersDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(root)) {
    if (file.startsWith(providersDir + path.sep)) continue;
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const code = stripComments(fs.readFileSync(file, "utf8"));

    for (const name of DISPLAY_NAMES) {
      if (code.includes(name)) violations.push({ file: relative, match: name });
    }
    for (const pattern of CHANGE_REQUEST_NOUNS) {
      const match = code.match(pattern);
      if (match) violations.push({ file: relative, match: match[0] });
    }
    if (!CREDENTIAL_VAR_ALLOWLIST.includes(relative)) {
      for (const variable of CREDENTIAL_VARS) {
        if (code.includes(variable)) violations.push({ file: relative, match: variable });
      }
    }
  }
  return violations;
}

describe("provider-copy source scan — real tree", () => {
  it("comes back clean against src/, outside the provider modules", () => {
    const violations = scanTree(SRC_ROOT, PROVIDERS_DIR);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("still allows BITBUCKET_TOKEN_ACME as a naming-shape example in credentials.ts", () => {
    const file = path.resolve(SRC_ROOT, "server/git/credentials.ts");
    expect(fs.readFileSync(file, "utf8")).toContain("BITBUCKET_TOKEN_ACME");
  });

  it("does not scan providers/ itself, where the display names and nouns legitimately live", () => {
    const violations = scanTree(PROVIDERS_DIR, PROVIDERS_DIR);
    expect(violations).toEqual([]);
  });
});

describe("provider-copy source scan — fixture tree", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixtureTree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-copy-fixture-"));
    tempDirs.push(root);
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return root;
  }

  it("fails on a new component file that hardcodes 'GitHub'", () => {
    const root = fixtureTree({
      "components/repo-link.tsx": 'export const label = "Open on GitHub";',
    });

    const violations = scanTree(root, path.join(root, "server/git/providers"));
    expect(violations).toEqual([{ file: "components/repo-link.tsx", match: "GitHub" }]);
  });

  it("fails on 'pull requests' (plural) and 'Merge Request' (capitalized), not just the exact-case singular", () => {
    const root = fixtureTree({
      "components/a.tsx": 'export const a = "Open pull requests here";',
      "components/b.tsx": 'export const b = "Open a Merge Request";',
    });

    const violations = scanTree(root, path.join(root, "server/git/providers"));
    expect(violations.map((v) => v.file).sort()).toEqual(["components/a.tsx", "components/b.tsx"]);
  });

  it("fails on a *_TOKEN literal the display-name pattern would miss", () => {
    const root = fixtureTree({
      "components/hint.tsx": 'export const hint = "GITLAB_TOKEN";',
    });

    const violations = scanTree(root, path.join(root, "server/git/providers"));
    expect(violations).toEqual([{ file: "components/hint.tsx", match: "GITLAB_TOKEN" }]);
  });

  it("passes the same banned word appearing only in a comment", () => {
    const root = fixtureTree({
      "components/note.tsx":
        'export const x = 1; // Mentions GitLab and "pull request" for humans only.',
    });

    const violations = scanTree(root, path.join(root, "server/git/providers"));
    expect(violations).toEqual([]);
  });

  it("passes the same banned word inside server/git/providers/", () => {
    const root = fixtureTree({
      "server/git/providers/github.ts": 'export const displayName = "GitHub";',
    });

    const violations = scanTree(root, path.join(root, "server/git/providers"));
    expect(violations).toEqual([]);
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
