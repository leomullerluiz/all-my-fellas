import {
  type ArtifactType,
  type Criticality,
  type Difficulty,
  CRITICALITIES,
  DIFFICULTIES,
} from "./stages";
import type { ReviewVerdict } from "./state-machine";

/**
 * Artifact contracts.
 *
 * Every stage hands the next one a Markdown document with a fixed set of
 * required sections. The worker validates the shape before advancing the
 * pipeline, which is what keeps the minimum-context handoff honest: a
 * downstream agent only ever sees a well-formed document, never a transcript.
 */

/** Hard ceiling per artifact; keeps a runaway agent from bloating later prompts. */
export const MAX_ARTIFACT_CHARS = 40_000;

export type ArtifactSpec = {
  type: ArtifactType;
  /** Level-2 headings that must be present, matched case-insensitively. */
  requiredSections: string[];
  /** Human readable description used in prompts and error messages. */
  description: string;
};

export const ARTIFACT_SPECS: Record<ArtifactType, ArtifactSpec> = {
  brief: {
    type: "brief",
    description: "Unambiguous restatement of the business demand",
    requiredSections: [
      "Business Intent",
      "Value",
      "Constraints",
      "Restated Requirement",
      "Open Questions",
    ],
  },
  stories: {
    type: "stories",
    description: "User stories with verifiable acceptance criteria",
    requiredSections: ["Summary", "User Stories", "Out of Scope"],
  },
  techplan: {
    type: "techplan",
    description: "Technical plan, affected files and estimates",
    requiredSections: ["Approach", "Affected Files", "Implementation Steps", "Risks", "Estimate"],
  },
  dev_report: {
    type: "dev_report",
    description: "What was implemented and how it was verified",
    requiredSections: ["Summary", "Changes", "Commands Run", "Follow-ups"],
  },
  code_review_report: {
    type: "code_review_report",
    description: "Code review verdict against the diff",
    requiredSections: ["Verdict", "Summary", "Findings", "Files Reviewed"],
  },
  qa_report: {
    type: "qa_report",
    description: "QA verdict against the acceptance criteria",
    requiredSections: ["Verdict", "Checks", "Acceptance Criteria Review", "Findings"],
  },
  human_review: {
    type: "human_review",
    description: "Changes a human reviewer asked for",
    requiredSections: ["Requested Changes"],
  },
  homolog_report: {
    type: "homolog_report",
    description: "Final acceptance-criteria checklist",
    requiredSections: ["Verdict", "Acceptance Criteria Checklist", "Notes"],
  },
};

export class ArtifactValidationError extends Error {
  constructor(
    readonly artifactType: ArtifactType,
    readonly problems: string[],
  ) {
    super(`Invalid ${artifactType} artifact: ${problems.join("; ")}`);
    this.name = "ArtifactValidationError";
  }
}

/**
 * Strips a wrapping ```markdown fence, which models add often enough that
 * rejecting the artifact over it would be pure friction.
 */
export function normalizeArtifact(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function headings(markdown: string): string[] {
  const found: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (match) found.push(match[1].toLowerCase());
  }
  return found;
}

/**
 * Validates an artifact against its spec.
 *
 * @returns the normalized markdown ready to persist.
 * @throws {ArtifactValidationError} when a required section or the body is missing.
 */
export function validateArtifact(type: ArtifactType, raw: string): string {
  const spec = ARTIFACT_SPECS[type];
  const content = normalizeArtifact(raw);
  const problems: string[] = [];

  if (content.length === 0) {
    problems.push("the document is empty");
  }
  if (content.length > MAX_ARTIFACT_CHARS) {
    problems.push(
      `the document is ${content.length} characters, over the ${MAX_ARTIFACT_CHARS} limit`,
    );
  }

  const present = headings(content);
  for (const section of spec.requiredSections) {
    const needle = section.toLowerCase();
    if (!present.some((heading) => heading.includes(needle))) {
      problems.push(`missing required section "## ${section}"`);
    }
  }

  if (problems.length > 0) throw new ArtifactValidationError(type, problems);
  return content;
}

/** Renders the section checklist injected into each role's prompt. */
export function describeArtifactContract(type: ArtifactType): string {
  const spec = ARTIFACT_SPECS[type];
  const sections = spec.requiredSections.map((section) => `## ${section}`).join("\n");
  return `${spec.description}. Required top-level sections, in this order:\n\n${sections}`;
}

/**
 * Reads a `Key: value` line out of a markdown document.
 *
 * Tolerates list markers and bold wrappers, e.g. `- **Difficulty:** M`.
 */
function readField(markdown: string, field: string): string | null {
  const pattern = new RegExp(`^[\\s>*-]*\\**${field}\\**\\s*:\\s*\\**\\s*([^*\\n]+)`, "im");
  const match = pattern.exec(markdown);
  return match ? match[1].trim().replace(/[.*_`]+$/, "").trim() : null;
}

export type PlanEstimate = {
  difficulty: Difficulty | null;
  criticality: Criticality | null;
};

/** Extracts the Architect's difficulty/criticality estimate from `techplan.md`. */
export function extractPlanEstimate(techplan: string): PlanEstimate {
  const rawDifficulty = readField(techplan, "Difficulty")?.toUpperCase() ?? null;
  const rawCriticality = readField(techplan, "Criticality")?.toLowerCase() ?? null;

  const difficulty =
    rawDifficulty && (DIFFICULTIES as readonly string[]).includes(rawDifficulty)
      ? (rawDifficulty as Difficulty)
      : null;
  const criticality =
    rawCriticality && (CRITICALITIES as readonly string[]).includes(rawCriticality)
      ? (rawCriticality as Criticality)
      : null;

  return { difficulty, criticality };
}

/**
 * Extracts the verdict from a reviewing stage's report — `code-review-report.md`
 * or `qa-report.md`, which share the same verdict shape.
 *
 * Fails closed: anything that cannot be read as `approved` counts as a
 * rejection, so an unparseable report can never be mistaken for a pass.
 */
export function extractReviewVerdict(report: string): ReviewVerdict {
  const value = readField(report, "Verdict")?.toLowerCase() ?? "";
  return /\bapproved\b/.test(value) && !/not\s+approved/.test(value)
    ? "approved"
    : "changes_requested";
}

/** Extracts the homologation verdict; same fail-closed rule as QA. */
export function extractHomologationVerdict(report: string): "accepted" | "rejected" {
  const value = readField(report, "Verdict")?.toLowerCase() ?? "";
  return /\baccepted\b/.test(value) && !/not\s+accepted/.test(value) ? "accepted" : "rejected";
}
