import type { RoleDefinition } from "../agents/roles";

/**
 * The one bounded repair turn for a malformed artifact — see stories.md S4.
 *
 * Deliberately its own `RoleDefinition` rather than the failing stage's own:
 * `allowedTools: []` and `canWrite: false` mean the shared `canUseTool` guard
 * (`guardrails.ts`) denies every tool regardless of what the failing stage
 * was permitted, so a repair turn can never touch the workspace. `produces`
 * is copied from the failing role so the repaired text is validated against
 * the same contract the original output was rejected against.
 */
export function buildRepairRole(role: RoleDefinition): RoleDefinition {
  return {
    stage: role.stage,
    name: `${role.name} (repair)`,
    promptFile: "repair.md",
    allowedTools: [],
    permissionMode: "default",
    consumes: [],
    produces: role.produces,
    needsWorkspace: false,
    canWrite: false,
    attachments: "none",
  };
}

/** A problem string naming the over-length case — see `artifacts.ts`'s `validateArtifact`. */
const OVER_LIMIT_PATTERN = /over the .+ limit/i;

/**
 * The repair instruction, chosen from the exact problems the rejected
 * artifact carried. Over-length is a different kind of fix than a missing
 * section — asking for reformatting would reproduce the same length — so it
 * gets its own instruction string, verifiably different from the
 * missing-section one (stories.md S4).
 */
export function repairInstructionFor(problems: string[]): string {
  if (problems.some((problem) => OVER_LIMIT_PATTERN.test(problem))) {
    return (
      "The document is over the character limit. Compress it to fit under the " +
      "limit while keeping every required section — shorten the prose, do not " +
      "just reformat it under the same words. Output only the corrected document."
    );
  }
  return (
    "The document is missing required structure. Fix exactly the problems " +
    "listed above while keeping everything else the document already got " +
    "right. Output only the corrected document."
  );
}
