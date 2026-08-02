import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Diff content is untrusted repository text.
 *
 * React escapes children, and this asserts it stays that way. The realistic
 * regression is someone later adding syntax highlighting with a library that
 * returns an HTML string — which would turn a malicious repository into stored
 * XSS against the dashboard. A highlighter returning React elements is fine.
 */

const SOURCE = path.resolve(import.meta.dirname, "../src/components/diff-viewer.tsx");

describe("diff viewer rendering safety", () => {
  it("never injects raw HTML", () => {
    const source = fs.readFileSync(SOURCE, "utf8");
    // Ignore the comment that explains the rule.
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toContain("dangerouslySetInnerHTML");
    expect(code).not.toContain("innerHTML");
  });
});
