import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { detectVerificationCommands } from "@/server/git/detect-verification";

/**
 * Manifest reading only — no clone, no network. `detectVerificationCommandsForRepo`
 * (the clone + cleanup wrapper) is covered indirectly by `api-repos.test.ts`'s
 * "still succeeds... when the detection clone cannot reach the host".
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-verification-test-"));

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

describe("detectVerificationCommands", () => {
  it("suggests npm commands for a package-lock.json project with all three scripts", async () => {
    const root = fixture("npm-full", {
      "package.json": JSON.stringify({
        scripts: { build: "next build", test: "vitest run", lint: "eslint" },
      }),
      "package-lock.json": "{}",
    });

    const suggestions = await detectVerificationCommands(root);
    expect(suggestions).toEqual({
      install: "npm ci",
      build: "npm run build",
      test: "npm test",
      lint: "npm run lint",
    });
  });

  it("leaves lint unsuggested when the script is missing, without touching build/test", async () => {
    const root = fixture("npm-no-lint", {
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }),
      "package-lock.json": "{}",
    });

    const suggestions = await detectVerificationCommands(root);
    expect(suggestions.lint).toBeUndefined();
    expect(suggestions.build).toBe("npm run build");
    expect(suggestions.test).toBe("npm test");
    expect(suggestions.install).toBe("npm ci");
  });

  it("prefers pnpm over npm when pnpm-lock.yaml is present", async () => {
    const root = fixture("pnpm", {
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }),
      "pnpm-lock.yaml": "",
      "package-lock.json": "{}",
    });

    const suggestions = await detectVerificationCommands(root);
    expect(suggestions.install).toBe("pnpm install --frozen-lockfile");
    expect(suggestions.build).toBe("pnpm build");
  });

  it("suggests nothing for a package.json with no lock file at all", async () => {
    const root = fixture("npm-no-lock", {
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });

    const suggestions = await detectVerificationCommands(root);
    expect(suggestions).toEqual({});
  });

  it("suggests Makefile targets only when the target line is declared", async () => {
    const withBuild = fixture("makefile-build", {
      Makefile: "build:\n\techo building\n",
    });
    expect((await detectVerificationCommands(withBuild)).build).toBe("make build");

    const withoutBuild = fixture("makefile-no-build", {
      Makefile: "test:\n\techo testing\n",
    });
    const suggestions = await detectVerificationCommands(withoutBuild);
    expect(suggestions.build).toBeUndefined();
    expect(suggestions.test).toBe("make test");
  });

  it("suggests go commands from go.mod", async () => {
    const root = fixture("go", { "go.mod": "module example.com/app\n\ngo 1.22\n" });
    const suggestions = await detectVerificationCommands(root);
    expect(suggestions).toEqual({
      install: "go mod download",
      build: "go build ./...",
      test: "go test ./...",
      lint: "go vet ./...",
    });
  });

  it("suggests poetry commands when a poetry.lock is present, pip otherwise", async () => {
    const withLock = fixture("poetry", {
      "pyproject.toml": "[tool.poetry]\nname = \"app\"\n",
      "poetry.lock": "",
    });
    expect(await detectVerificationCommands(withLock)).toEqual({
      install: "poetry install",
      test: "poetry run pytest",
      lint: "poetry run ruff check .",
    });

    const withoutLock = fixture("pip", { "pyproject.toml": "[project]\nname = \"app\"\n" });
    expect(await detectVerificationCommands(withoutLock)).toEqual({
      install: "pip install -e .",
      test: "pytest",
      lint: "ruff check .",
    });
  });
});
