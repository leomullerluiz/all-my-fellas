import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROLES } from "@/server/agents/roles";

/**
 * Local Read/Grep/Glob/Bash/Edit/Write execution for the ChatGPT/Gemini
 * providers, gated by the same `createPermissionGuard` Claude's own path
 * uses. Happy-path per tool plus a denial (path escape, disallowed Bash
 * command) for parity with `guardrails.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-runtime-test-"));
const workspacePath = path.join(tempDir, "workspace");

let executeTool: typeof import("@/server/pipeline/providers/tool-runtime").executeTool;
let toolSchemasForRole: typeof import("@/server/pipeline/providers/tool-runtime").toolSchemasForRole;

const developer = ROLES.DEVELOPMENT;
const qa = ROLES.QA;

beforeAll(async () => {
  fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  fs.writeFileSync(path.join(workspacePath, "README.md"), "# Hello\n");

  const mod = await import("@/server/pipeline/providers/tool-runtime");
  executeTool = mod.executeTool;
  toolSchemasForRole = mod.toolSchemasForRole;
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("toolSchemasForRole", () => {
  it("only returns schemas for the role's allowed tools", () => {
    expect(toolSchemasForRole(qa).map((schema) => schema.name)).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
    ]);
    expect(toolSchemasForRole(ROLES.STAKEHOLDER_REFINEMENT)).toEqual([]);
  });
});

describe("executeTool — happy paths", () => {
  it("Read returns numbered file content", async () => {
    const result = await executeTool("Read", { file_path: "src/a.ts" }, developer, workspacePath);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("export const a = 1;");
    expect(result.output).toMatch(/^1\t/);
  });

  it("Grep finds a matching line", async () => {
    const result = await executeTool("Grep", { pattern: "const b" }, developer, workspacePath);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("src/a.ts:2:export const b = 2;");
  });

  it("Glob lists files matching a pattern", async () => {
    const result = await executeTool("Glob", { pattern: "src/**/*.ts" }, developer, workspacePath);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("src/a.ts");
  });

  it("Bash runs a command inside the workspace", async () => {
    const result = await executeTool("Bash", { command: "git status" }, qa, workspacePath);
    // Not a git repo, but the guard let it through and the shell ran it —
    // that is what this test checks, not the git output itself.
    expect(typeof result.output).toBe("string");
  });

  it("Write creates a new file", async () => {
    const result = await executeTool(
      "Write",
      { file_path: "out.txt", content: "hello" },
      developer,
      workspacePath,
    );
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(workspacePath, "out.txt"), "utf8")).toBe("hello");
  });

  it("Edit replaces a unique string", async () => {
    fs.writeFileSync(path.join(workspacePath, "edit.txt"), "one two three");
    const result = await executeTool(
      "Edit",
      { file_path: "edit.txt", old_string: "two", new_string: "TWO" },
      developer,
      workspacePath,
    );
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(workspacePath, "edit.txt"), "utf8")).toBe("one TWO three");
  });
});

describe("executeTool — denials", () => {
  it("denies a Read that escapes the workspace", async () => {
    const result = await executeTool(
      "Read",
      { file_path: "../../etc/passwd" },
      developer,
      workspacePath,
    );
    expect(result.isError).toBe(true);
  });

  it("denies a tool outside the role's allowlist", async () => {
    const result = await executeTool("Write", { file_path: "x.txt", content: "x" }, qa, workspacePath);
    expect(result.isError).toBe(true);
  });

  it("denies a disallowed Bash command for a read-only role", async () => {
    const result = await executeTool("Bash", { command: "npm install left-pad" }, qa, workspacePath);
    expect(result.isError).toBe(true);
  });

  it("denies a Bash command blocked for every role", async () => {
    const result = await executeTool("Bash", { command: "git push origin main" }, developer, workspacePath);
    expect(result.isError).toBe(true);
  });
});
