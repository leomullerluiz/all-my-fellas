import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import type { AgentStage, ArtifactType } from "../pipeline/stages";

/**
 * Least-privilege definition of each agent role.
 *
 * Only the Developer may write. The Architect and QA get Bash for read-only
 * inspection, constrained further at runtime by the command allowlist in
 * `pipeline/guardrails.ts`.
 *
 * Every role runs in `default` permission mode with an empty auto-allow list,
 * so the `canUseTool` guard is consulted for every single tool call. Using
 * `acceptEdits` for the Developer would have bypassed the guard on exactly the
 * tools that need it most.
 */
export type RoleDefinition = {
  stage: AgentStage;
  /** Human readable role name used in prompts and the UI. */
  name: string;
  /** Markdown file under `prompts/` holding the system prompt. */
  promptFile: string;
  /** Built-in Claude Code tools available to the session. */
  allowedTools: string[];
  permissionMode: PermissionMode;
  /** Artifacts fed into the prompt, in order. */
  consumes: ArtifactType[];
  /** Artifact the stage must produce before the pipeline advances. */
  produces: ArtifactType;
  /** Whether the agent needs the repository clone as its working directory. */
  needsWorkspace: boolean;
  /** Whether the agent is allowed to modify files in the workspace. */
  canWrite: boolean;
  /**
   * Which of the task's attachments reach this role's prompt.
   *
   * `"all"` — every attachment kind (JSON/XML/PDF text plus, per stories.md
   * S5, images). `"documents"` — text-shaped kinds only, no images: a spec
   * PDF informs a plan, a screenshot rarely does. `"none"` — the roles that
   * review against `stories.md`, which already encodes what the attachments
   * said, so re-sending them is cost with no benefit.
   */
  attachments: "all" | "documents" | "none";
};

export const ROLES: Record<AgentStage, RoleDefinition> = {
  STAKEHOLDER_REFINEMENT: {
    stage: "STAKEHOLDER_REFINEMENT",
    name: "Stakeholder",
    promptFile: "stakeholder.md",
    // Text-only reasoning: no repository access at all.
    allowedTools: [],
    permissionMode: "default",
    consumes: [],
    produces: "brief",
    needsWorkspace: false,
    canWrite: false,
    // No repository access at all — attachments are its only context beyond
    // the text it was given.
    attachments: "all",
  },
  PO_REFINEMENT: {
    stage: "PO_REFINEMENT",
    name: "Product Owner",
    promptFile: "product-owner.md",
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "default",
    consumes: ["brief"],
    produces: "stories",
    needsWorkspace: true,
    canWrite: false,
    // Writes the acceptance criteria the attachments usually describe.
    attachments: "all",
  },
  ARCHITECTURE: {
    stage: "ARCHITECTURE",
    name: "Architect",
    promptFile: "architect.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "default",
    consumes: ["brief", "stories"],
    produces: "techplan",
    needsWorkspace: true,
    canWrite: false,
    // A spec PDF or JSON schema informs the plan; a screenshot rarely does.
    attachments: "documents",
  },
  DEVELOPMENT: {
    stage: "DEVELOPMENT",
    name: "Developer",
    promptFile: "developer.md",
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    permissionMode: "default",
    // `qa_report` is appended by the worker on rework cycles only.
    consumes: ["stories", "techplan"],
    produces: "dev_report",
    needsWorkspace: true,
    canWrite: true,
    // Implements against the mock-up.
    attachments: "all",
  },
  CODE_REVIEW: {
    stage: "CODE_REVIEW",
    name: "Code Reviewer",
    promptFile: "code-reviewer.md",
    // Read-only. The reviewer needs `git diff`/`log`/`show`, all already on the
    // Bash allowlist, and deliberately does not run the test suite: that is
    // QA's job and doubling it would double the slowest part of the pipeline.
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "default",
    consumes: ["stories", "techplan", "dev_report"],
    produces: "code_review_report",
    needsWorkspace: true,
    canWrite: false,
    // Reviews against `stories.md`, which already encodes what the
    // attachments said.
    attachments: "none",
  },
  QA: {
    stage: "QA",
    name: "QA Engineer",
    promptFile: "qa.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "default",
    consumes: ["stories", "dev_report"],
    produces: "qa_report",
    needsWorkspace: true,
    canWrite: false,
    attachments: "none",
  },
  PO_HOMOLOGATION: {
    stage: "PO_HOMOLOGATION",
    name: "Product Owner (homologation)",
    promptFile: "homologation.md",
    allowedTools: ["Read"],
    permissionMode: "default",
    consumes: ["stories", "qa_report"],
    produces: "homolog_report",
    needsWorkspace: true,
    canWrite: false,
    // Left "none" per stories.md S1/§11.2's open question: it checks
    // acceptance criteria against `stories.md`, not the raw attachments.
    attachments: "none",
  },
};

export function roleFor(stage: AgentStage): RoleDefinition {
  return ROLES[stage];
}
