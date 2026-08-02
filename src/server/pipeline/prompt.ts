import fs from "node:fs";
import path from "node:path";

import type { RoleDefinition } from "../agents/roles";
import { resolvePromptsDir } from "../config/env";
import { describeArtifactContract } from "./artifacts";
import { ARTIFACT_FILENAMES, type ArtifactType } from "./stages";

/**
 * Prompt assembly for a single stage.
 *
 * This is where the minimum-context handoff is enforced: the prompt is built
 * from the role's system prompt, the task metadata, and the specific artifacts
 * the role declares it consumes — never from another agent's transcript.
 */

export type ArtifactInput = { type: ArtifactType; content: string };

export type StagePromptInput = {
  role: RoleDefinition;
  task: {
    id: string;
    title: string;
    description: string;
    priority: string;
    repoName: string;
    branchName: string | null;
  };
  artifacts: ArtifactInput[];
  /** Extra role-specific context, e.g. the branch diff handed to QA. */
  supplements?: Array<{ label: string; body: string; fenced?: boolean }>;
  /** 1-based; surfaced so a rework agent knows it is on a second pass. */
  attempt: number;
};

const promptCache = new Map<string, string>();

/** Loads a role system prompt from `prompts/`, cached per file. */
export function loadSystemPrompt(promptFile: string): string {
  const cached = promptCache.get(promptFile);
  if (cached !== undefined) return cached;

  const filePath = path.join(resolvePromptsDir(), promptFile);
  const content = fs.readFileSync(filePath, "utf8");
  promptCache.set(promptFile, content);
  return content;
}

/** Clears the prompt cache so edits under `prompts/` apply without a restart. */
export function invalidatePromptCache(): void {
  promptCache.clear();
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`;
}

/**
 * Builds the full system prompt: the role file plus the output contract the
 * worker will validate against.
 */
export function buildSystemPrompt(role: RoleDefinition): string {
  const rolePrompt = loadSystemPrompt(role.promptFile);
  const contract = describeArtifactContract(role.produces);
  const filename = ARTIFACT_FILENAMES[role.produces];

  return `${rolePrompt}

---

# Output contract (enforced)

Your final message is the deliverable. It is saved verbatim as \`${filename}\`
and handed to the next stage — nothing else you write is passed on.

${contract}

Rules:
- The final message must contain the Markdown document and nothing else: no
  preamble, no "here is the document", no closing commentary.
- Do not wrap the document in a code fence.
- Use \`##\` for the required sections and keep them in the order listed.
- If a section has nothing to report, write the heading and \`None.\` under it.
  Never omit a heading.
`;
}

/** Builds the user-turn prompt handed to `query()`. */
export function buildStagePrompt(input: StagePromptInput): string {
  const { role, task, artifacts, supplements = [], attempt } = input;
  const parts: string[] = [];

  parts.push(
    section(
      "Task",
      [
        `- **Id:** ${task.id}`,
        `- **Title:** ${task.title}`,
        `- **Repository:** ${task.repoName}`,
        `- **Priority:** ${task.priority}`,
        task.branchName ? `- **Branch:** ${task.branchName}` : null,
        `- **Stage:** ${role.name}`,
        attempt > 1 ? `- **Attempt:** ${attempt} (rework cycle)` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    ),
  );

  parts.push(section("Original request", task.description));

  for (const artifact of artifacts) {
    parts.push(
      section(
        `Input artifact: ${ARTIFACT_FILENAMES[artifact.type]}`,
        artifact.content,
      ),
    );
  }

  for (const supplement of supplements) {
    const body = supplement.fenced ? `\`\`\`\n${supplement.body}\n\`\`\`` : supplement.body;
    parts.push(section(supplement.label, body));
  }

  parts.push(
    section(
      "Now",
      `Produce \`${ARTIFACT_FILENAMES[role.produces]}\` as described in the output contract.`,
    ),
  );

  return parts.join("\n");
}

/** Truncates long supplements (diffs) so a prompt cannot blow up the context. */
export function truncateForPrompt(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[... truncated, ${
    body.length - maxChars
  } more characters ...]`;
}
