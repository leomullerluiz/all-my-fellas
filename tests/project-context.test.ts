import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectContext } from "@/server/pipeline/project-context";

/**
 * S2 — repository conventions reach every provider.
 *
 * `loadProjectContext` itself is provider-agnostic: it just reads the
 * workspace's filesystem. The per-provider "don't duplicate what Claude's SDK
 * already loaded" rule lives in `execute.ts` and is covered by
 * `execute-attachments.test.ts`'s sibling suites instead — see stories.md S2.
 */

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-context-test-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe("loadProjectContext", () => {
  it("returns null for a null workspace path (text-only roles)", () => {
    expect(loadProjectContext(null)).toBeNull();
  });

  it("returns null for a workspace with neither file", () => {
    expect(loadProjectContext(workspaceDir)).toBeNull();
  });

  it("prefers AGENTS.md over CLAUDE.md when both are present", () => {
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "agents content");
    fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), "claude content");

    const result = loadProjectContext(workspaceDir);
    expect(result).toEqual({ source: "AGENTS.md", content: "agents content" });
  });

  it("falls back to CLAUDE.md when AGENTS.md is absent", () => {
    fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), "claude content");

    const result = loadProjectContext(workspaceDir);
    expect(result).toEqual({ source: "CLAUDE.md", content: "claude content" });
  });

  it("falls back to .github/copilot-instructions.md when neither AGENTS.md nor CLAUDE.md exist", () => {
    fs.mkdirSync(path.join(workspaceDir, ".github"));
    fs.writeFileSync(
      path.join(workspaceDir, ".github", "copilot-instructions.md"),
      "copilot content",
    );

    const result = loadProjectContext(workspaceDir);
    expect(result).toEqual({ source: ".github/copilot-instructions.md", content: "copilot content" });
  });
});
