import { describe, expect, it } from "vitest";

import {
  ArtifactValidationError,
  MAX_ARTIFACT_CHARS,
  extractHomologationVerdict,
  extractPlanEstimate,
  extractQaVerdict,
  normalizeArtifact,
  validateArtifact,
} from "@/server/pipeline/artifacts";

const VALID_BRIEF = `# Brief

## Business Intent
Reduce time to find a recent order.

## Value
Support agents stop scrolling.

## Constraints
Must not change the public API.

## Restated Requirement
Archived orders are hidden from the default list.

## Open Questions
None.
`;

describe("normalizeArtifact", () => {
  it("strips a wrapping markdown fence", () => {
    expect(normalizeArtifact("```markdown\n# Title\n\nBody\n```")).toBe("# Title\n\nBody");
  });

  it("strips a bare fence", () => {
    expect(normalizeArtifact("```\n# Title\n```")).toBe("# Title");
  });

  it("leaves unfenced content alone, including inner fences", () => {
    const content = "# Title\n\n```ts\nconst a = 1;\n```\n\nDone.";
    expect(normalizeArtifact(content)).toBe(content);
  });
});

describe("validateArtifact", () => {
  it("accepts a document with every required section", () => {
    expect(validateArtifact("brief", VALID_BRIEF)).toContain("## Business Intent");
  });

  it("accepts a fenced document", () => {
    expect(validateArtifact("brief", "```markdown\n" + VALID_BRIEF + "\n```")).toContain(
      "## Restated Requirement",
    );
  });

  it("rejects a document with a missing section and names it", () => {
    const withoutValue = VALID_BRIEF.replace("## Value\nSupport agents stop scrolling.\n", "");
    try {
      validateArtifact("brief", withoutValue);
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError);
      expect((error as ArtifactValidationError).problems.join(" ")).toContain("Value");
    }
  });

  it("rejects an empty document", () => {
    expect(() => validateArtifact("brief", "   ")).toThrow(ArtifactValidationError);
  });

  it("rejects a document over the size limit", () => {
    const oversized = `${VALID_BRIEF}\n${"x".repeat(MAX_ARTIFACT_CHARS)}`;
    expect(() => validateArtifact("brief", oversized)).toThrow(/over the/);
  });

  it("matches section headings case-insensitively", () => {
    expect(() => validateArtifact("brief", VALID_BRIEF.toUpperCase())).not.toThrow();
  });
});

describe("extractPlanEstimate", () => {
  it("reads a plain estimate block", () => {
    const plan = "## Estimate\n\nDifficulty: M\nCriticality: high\n";
    expect(extractPlanEstimate(plan)).toEqual({ difficulty: "M", criticality: "high" });
  });

  it("tolerates list markers and bold wrappers", () => {
    const plan = "## Estimate\n\n- **Difficulty:** L\n- **Criticality:** low\n";
    expect(extractPlanEstimate(plan)).toEqual({ difficulty: "L", criticality: "low" });
  });

  it("returns nulls for values it cannot parse", () => {
    expect(extractPlanEstimate("## Estimate\n\nDifficulty: enormous\n")).toEqual({
      difficulty: null,
      criticality: null,
    });
  });
});

describe("extractQaVerdict", () => {
  it("reads an approval", () => {
    expect(extractQaVerdict("## Verdict\n\nVerdict: approved\n")).toBe("approved");
  });

  it("reads a change request", () => {
    expect(extractQaVerdict("## Verdict\n\nVerdict: changes_requested\n")).toBe(
      "changes_requested",
    );
  });

  it("fails closed when the verdict is unreadable", () => {
    expect(extractQaVerdict("## Verdict\n\nLooks fine to me!\n")).toBe("changes_requested");
  });

  it("does not read 'not approved' as an approval", () => {
    expect(extractQaVerdict("## Verdict\n\nVerdict: not approved\n")).toBe("changes_requested");
  });
});

describe("extractHomologationVerdict", () => {
  it("reads an acceptance", () => {
    expect(extractHomologationVerdict("## Verdict\n\nVerdict: accepted\n")).toBe("accepted");
  });

  it("fails closed on anything else", () => {
    expect(extractHomologationVerdict("## Verdict\n\nMostly there.\n")).toBe("rejected");
  });
});
