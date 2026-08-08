import { describe, expect, it } from "vitest";

import { parseDiffSummaryArtifact, renderDiffSummaryArtifact } from "@/server/pipeline/diff-summary";
import { validateArtifact } from "@/server/pipeline/artifacts";
import type { DiffIndex } from "@/server/git/diff";

/**
 * The `diff_summary` artifact (S4 / spec-audit-trail.md §8): the cheap part of
 * the diff, persisted before the workspace is cleaned up.
 */

const index: DiffIndex = {
  baseBranch: "main",
  files: [
    { path: "src/foo.ts", status: "modified", additions: 12, deletions: 3, binary: false },
    { path: "src/new.ts", status: "added", additions: 40, deletions: 0, binary: false },
    { path: "src/old.ts", status: "deleted", additions: 0, deletions: 20, binary: false },
    { path: "src/renamed-to.ts", oldPath: "src/renamed-from.ts", status: "renamed", additions: 1, deletions: 1, binary: false },
    { path: "assets/logo.png", status: "modified", additions: 0, deletions: 0, binary: true },
  ],
  truncated: false,
  totalAdditions: 53,
  totalDeletions: 24,
};

describe("renderDiffSummaryArtifact / parseDiffSummaryArtifact", () => {
  it("validates against the diff_summary artifact spec (## Summary and ## Files)", () => {
    const body = renderDiffSummaryArtifact({
      baseBranch: "main",
      headBranch: "pipeline/task_1-do-the-thing",
      headCommitSha: "abc123def456",
      index,
    });

    expect(() => validateArtifact("diff_summary", body)).not.toThrow();
  });

  it("round-trips base/head/sha and the per-file table", () => {
    const body = renderDiffSummaryArtifact({
      baseBranch: "main",
      headBranch: "pipeline/task_1-do-the-thing",
      headCommitSha: "abc123def456",
      index,
    });

    const parsed = parseDiffSummaryArtifact(body);

    expect(parsed.baseBranch).toBe("main");
    expect(parsed.headBranch).toBe("pipeline/task_1-do-the-thing");
    expect(parsed.headCommitSha).toBe("abc123def456");
    expect(parsed.totalAdditions).toBe(53);
    expect(parsed.totalDeletions).toBe(24);
    expect(parsed.files).toHaveLength(5);

    const renamed = parsed.files.find((file) => file.path === "src/renamed-to.ts");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "src/renamed-from.ts" });

    const binary = parsed.files.find((file) => file.path === "assets/logo.png");
    expect(binary?.binary).toBe(true);
  });

  it("renders 'None.' for a diff with no files, and parses it back to an empty list", () => {
    const body = renderDiffSummaryArtifact({
      baseBranch: "main",
      headBranch: "pipeline/task_1-empty",
      headCommitSha: "sha0",
      index: { baseBranch: "main", files: [], truncated: false, totalAdditions: 0, totalDeletions: 0 },
    });

    expect(() => validateArtifact("diff_summary", body)).not.toThrow();
    const parsed = parseDiffSummaryArtifact(body);
    expect(parsed.files).toHaveLength(0);
  });

  it("marks truncated when the file list was capped", () => {
    const body = renderDiffSummaryArtifact({
      baseBranch: "main",
      headBranch: "pipeline/task_1-huge",
      headCommitSha: "sha1",
      index: { ...index, truncated: true },
    });

    expect(parseDiffSummaryArtifact(body).truncated).toBe(true);
  });
});
