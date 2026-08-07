import type { DiffFile, DiffIndex, DiffStatus } from "../git/diff";

/**
 * Renders and parses the `diff_summary` artifact — spec-audit-trail.md §8.
 *
 * `spec-code-review.md` §10.1 specified persisting only the cheap part of the
 * diff at `DELIVERY`, before the workspace is removed by cleanup: the
 * `--name-status` list plus per-file added/removed counts. Kept as a regular
 * validated Markdown artifact (`Summary`/`Files` sections) rather than a
 * bespoke JSON column, so it goes through the same `validateArtifact` /
 * `ARTIFACT_SPECS` machinery as every other artifact type, at the cost of this
 * one small parser to read the file table back for the diff route.
 */

const STATUS_LETTER: Record<DiffStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

const LETTER_STATUS: Record<string, DiffStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
};

export type DiffSummaryInput = {
  baseBranch: string;
  headBranch: string;
  /** `git rev-parse HEAD` on the task branch — the only link back to a commit once the clone is gone. */
  headCommitSha: string;
  index: DiffIndex;
};

function filePathCell(file: DiffFile): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

/** Renders the `diff_summary` artifact body from a computed {@link DiffIndex}. */
export function renderDiffSummaryArtifact(input: DiffSummaryInput): string {
  const { baseBranch, headBranch, headCommitSha, index } = input;

  const summary = [
    `- Base branch: \`${baseBranch}\``,
    `- Head branch: \`${headBranch}\``,
    `- Head commit: \`${headCommitSha}\``,
    `- Files changed: ${index.files.length}${index.truncated ? " (list capped)" : ""}`,
    `- Additions: +${index.totalAdditions}`,
    `- Deletions: −${index.totalDeletions}`,
  ].join("\n");

  const files =
    index.files.length === 0
      ? "None."
      : [
          "| Status | Path | + | − |",
          "|---|---|---|---|",
          ...index.files.map(
            (file) =>
              `| ${STATUS_LETTER[file.status]} | ${filePathCell(file)} | ${file.binary ? "bin" : file.additions} | ${
                file.binary ? "bin" : file.deletions
              } |`,
          ),
        ].join("\n");

  return ["## Summary", "", summary, "", "## Files", "", files].join("\n");
}

export type ParsedDiffSummary = {
  baseBranch: string | null;
  headBranch: string | null;
  headCommitSha: string | null;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
};

function readSummaryField(summary: string, label: string): string | null {
  const match = new RegExp(`^-\\s*${label}:\\s*\`([^\`]+)\``, "im").exec(summary);
  return match ? match[1] : null;
}

/** Reads a `diff_summary` artifact body back into structured data — the diff route's post-cleanup fallback. */
export function parseDiffSummaryArtifact(markdown: string): ParsedDiffSummary {
  const summarySection = /##\s*Summary\s*\n([\s\S]*?)(?=\n##\s*Files|$)/i.exec(markdown)?.[1] ?? "";
  const filesSection = /##\s*Files\s*\n([\s\S]*)$/i.exec(markdown)?.[1] ?? "";

  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of filesSection.split("\n")) {
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== 4) continue;
    const [statusCell, pathCell, addCell, delCell] = cells;
    const status = LETTER_STATUS[statusCell];
    if (!status) continue; // header row, separator row, or "None."

    const binary = addCell === "bin" || delCell === "bin";
    const additions = binary ? 0 : Number.parseInt(addCell, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(delCell, 10) || 0;
    totalAdditions += additions;
    totalDeletions += deletions;

    const renameMatch = /^(.+?)\s+→\s+(.+)$/.exec(pathCell);
    files.push(
      renameMatch
        ? { status, oldPath: renameMatch[1], path: renameMatch[2], additions, deletions, binary }
        : { status, path: pathCell, additions, deletions, binary },
    );
  }

  return {
    baseBranch: readSummaryField(summarySection, "Base branch"),
    headBranch: readSummaryField(summarySection, "Head branch"),
    headCommitSha: readSummaryField(summarySection, "Head commit"),
    files,
    totalAdditions,
    totalDeletions,
    truncated: /\(list capped\)/.test(summarySection),
  };
}
