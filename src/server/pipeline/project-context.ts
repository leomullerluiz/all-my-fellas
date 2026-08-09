import fs from "node:fs";
import path from "node:path";

/**
 * Provider-neutral repository conventions.
 *
 * `settingSources: ["project"]` (`providers/claude.ts`) makes Claude alone
 * load the target repository's own `CLAUDE.md`; OpenAI and Gemini build the
 * identical prompt with nothing equivalent — see stories.md S2. This module
 * closes that gap by reading the file directly and handing it back as one
 * more supplement, for every provider, keyed to whichever file the workspace
 * actually has.
 */

/** Checked in order; the first one present wins. */
const CANDIDATES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"] as const;

export type ProjectContextSource = (typeof CANDIDATES)[number];

export type ProjectContext = {
  source: ProjectContextSource;
  content: string;
};

/** Caps the supplement so a sprawling conventions file cannot blow up a prompt. */
export const MAX_PROJECT_CONTEXT_CHARS = 20_000;

/**
 * Reads the first repository-conventions file present at the workspace root.
 *
 * `AGENTS.md` goes first because it is the vendor-neutral convention — and
 * because this very repository's `CLAUDE.md` is a one-line `@AGENTS.md`
 * include the Claude SDK resolves and the other providers could not.
 *
 * Returns `null` for a `null` workspace path (text-only roles, e.g. the
 * Stakeholder) and for a workspace with none of the candidate files. Never
 * throws: a file that exists but cannot be read is treated the same as one
 * that does not.
 */
export function loadProjectContext(workspacePath: string | null): ProjectContext | null {
  if (!workspacePath) return null;

  for (const source of CANDIDATES) {
    try {
      const content = fs.readFileSync(path.join(workspacePath, source), "utf8");
      return { source, content };
    } catch {
      continue;
    }
  }

  return null;
}
