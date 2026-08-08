import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Transcript content is untrusted repository text — verbatim file contents,
 * command output, and whatever an agent typed. React escapes children, and
 * this asserts it stays that way, mirroring `tests/diff-viewer-safety.test.ts`
 * for the diff viewer.
 */

const SOURCES = [
  path.resolve(import.meta.dirname, "../src/components/transcript-viewer.tsx"),
  path.resolve(import.meta.dirname, "../src/app/(dashboard)/tasks/[id]/runs/[runId]/page.tsx"),
];

describe("transcript viewer rendering safety", () => {
  it.each(SOURCES)("never injects raw HTML (%s)", (sourcePath) => {
    const source = fs.readFileSync(sourcePath, "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toContain("dangerouslySetInnerHTML");
    expect(code).not.toContain("innerHTML");
  });
});
