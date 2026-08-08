import { z } from "zod";

import { LLM_PROVIDER_IDS } from "../config/llm-providers";
import { validateCredentialRef } from "../git/credentials";
import { PROVIDER_IDS } from "../git/providers/types";
import { AGENT_STAGES, GATES, GATE_DECISIONS, PRIORITIES, TASK_STATUSES } from "../pipeline/stages";
import { THEMES } from "../settings/store";

/**
 * Request payload schemas, shared between the route handlers and the client
 * forms so both sides validate against the same rules.
 */

/**
 * A close but not exhaustive subset of `git check-ref-format`'s rules — just
 * enough to catch what would otherwise fail obscurely at `checkoutBranch`
 * time. Returns the violation message, or `null` when `value` (already
 * trimmed) is legal.
 */
function branchNameViolation(value: string): string | null {
  if (value === "@") return "That is not a valid branch name.";
  if (value.length > 200) return "Branch names can be at most 200 characters.";
  if (/[\s~^:?*[`]/.test(value)) {
    return "Branch names cannot contain spaces or any of ~ ^ : ? * [ `.";
  }
  if (value.includes("..")) return "Branch names cannot contain \"..\".";
  if (/^[-./]/.test(value)) return "Branch names cannot start with -, ., or /.";
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    return "Branch names cannot end with /, ., or .lock.";
  }
  return null;
}

/** The fields a task carries, shared by creation and editing. */
export const taskFieldsSchema = z.object({
  repoId: z.string().min(1, "Select a repository."),
  title: z.string().trim().min(3, "Give the task a title.").max(160),
  description: z
    .string()
    .trim()
    .min(20, "Describe the feature in at least 20 characters.")
    .max(50_000),
  priority: z.enum(PRIORITIES).default("medium"),
  /** Park at HUMAN_CODE_REVIEW before delivery. Not changeable after start. */
  requireHumanCodeReview: z.boolean().default(false),
  /**
   * Overrides the auto-generated `pipeline/{taskId}-{slug}` branch. Only the
   * create path (`POST /api/tasks`) reads it — see `service.ts`'s
   * `createTask` and `EditableTaskFields`, which deliberately does not carry
   * it, since editing a task's branch after creation is out of scope.
   *
   * A blank/whitespace-only value is treated as "not provided", matching the
   * fallback-to-auto-generation behavior; only a non-empty value is checked
   * against git's ref-name rules.
   */
  branchName: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const violation = branchNameViolation(value);
      if (violation) {
        ctx.addIssue({ code: "custom", message: violation });
        return z.NEVER;
      }
      return value;
    }),
  /**
   * Ids of tasks that must reach `COMPLETED` before this one can be started.
   *
   * A `multipart/form-data` submission repeats the `dependsOn` field once per
   * selected id rather than sending a JSON array, so a single selection
   * arrives as a bare string — the `preprocess` normalizes both shapes (and
   * an omitted field) to an array before the length/content checks run.
   */
  dependsOn: z.preprocess(
    (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
    z.array(z.string().min(1)).max(50),
  ),
});

export const createTaskSchema = taskFieldsSchema.extend({
  /**
   * Whether to enter the pipeline immediately. Defaults to false: a task left
   * sitting costs nothing, a task started by accident costs quota and a clone.
   */
  start: z.boolean().default(false),
  /**
   * The task this one duplicates, so `POST /api/tasks` can copy its
   * attachments onto the new row — see `stories.md` S4. A missing/deleted
   * source is tolerated (the task is still created, just without the extra
   * attachments), so this is not validated against `getTask` here.
   */
  duplicateFrom: z.string().min(1).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/** Editing is only allowed while a task is still at `CREATED`. */
export const updateTaskSchema = taskFieldsSchema;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const listTasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
});

export const batchStartSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1, "Select at least one task."),
});
export type BatchStartInput = z.infer<typeof batchStartSchema>;

export const gateDecisionSchema = z
  .object({
    decision: z.enum(GATE_DECISIONS),
    comment: z.string().trim().max(4_000).optional(),
  })
  .refine(
    (value) => value.decision !== "request_changes" || (value.comment ?? "") !== "",
    {
      // Without it the Developer has nothing to act on and a full rework cycle
      // is spent re-submitting the same code.
      message: "Requesting changes needs a comment saying what to change.",
      path: ["comment"],
    },
  );
export type GateDecisionInput = z.infer<typeof gateDecisionSchema>;

export const gateParamSchema = z.enum(GATES);

/**
 * One configured verification command (`repos.verify_install` etc.), shared
 * by `createRepoSchema` (accepted but not persisted — see §5.2's "detection
 * never saves anything") and `updateVerificationCommandsSchema` (the only
 * route that actually writes it).
 *
 * These characters are not a sanitiser — the command never reaches a shell
 * (it is split into argv and spawned with `shell: false`), so there is
 * nothing to sanitise. They are a contract: a field that accepted `a && b`
 * and then ran it as a single argv would do nothing useful, and the operator
 * deserves the error rather than the mystery.
 */
const VERIFY_COMMAND_FORBIDDEN = /[;&|`$<>(){}\n\r\\]/;

const verifyCommandSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  // A half-cleared form disables the command rather than storing one that
  // spawns nothing — the same normalisation every other optional field here
  // already applies.
  .transform((value) => (value === "" ? undefined : value))
  .refine((value) => value === undefined || !VERIFY_COMMAND_FORBIDDEN.test(value), {
    message:
      "One command, no shell syntax. To chain steps, add a script to the " +
      "repository and point this field at it.",
  });

const verifyTimeoutSecondsSchema = z.number().int().min(30).max(3600).optional();

export const createRepoSchema = z
  .object({
    name: z.string().trim().min(1, "Give the connection a name.").max(120),
    /**
     * Must be an http(s) URL with a host.
     *
     * `z.url()` alone is not enough: it accepts `ext::sh -c '…'`, which is
     * git's remote-helper syntax and runs a shell at clone time. The URL
     * reaches `git clone` almost verbatim, so this is the boundary that has to
     * reject it — the provider layer repeats the check as defence in depth.
     */
    url: z
      .string()
      .trim()
      .max(500)
      .refine(
        (value) => {
          try {
            const parsed = new URL(value);
            return (
              (parsed.protocol === "https:" || parsed.protocol === "http:") &&
              parsed.hostname !== ""
            );
          } catch {
            return false;
          }
        },
        { message: "Enter the full https:// URL of the repository." },
      ),
    defaultBranch: z.string().trim().min(1).max(120).default("main"),
    /** Omitted means "auto-detect from the URL". */
    provider: z.enum(PROVIDER_IDS).optional(),
    /**
     * Environment variable NAME, never a secret. Validated against a naming
     * rule and a reserved list, without which this field would be an
     * arbitrary-environment-variable read primitive.
     */
    credentialRef: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value === "" ? undefined : value))
      .refine((value) => value === undefined || validateCredentialRef(value).ok, {
        message:
          "Use an environment variable name (A-Z, digits, underscores) that the " +
          "pipeline does not reserve.",
      }),
    credentialUsername: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    apiBaseUrl: z
      .string()
      .trim()
      .max(300)
      .optional()
      .transform((value) => (value === "" ? undefined : value))
      .refine((value) => value === undefined || /^https?:\/\//.test(value), {
        message: "The API base URL must start with http:// or https://.",
      }),
    /**
     * Free-text project documentation, handed to every stage prompt so the
     * Architect and Developer (and everyone else) starts from the project's
     * stated structure and rules instead of inferring them from the diff.
     * Capped like `taskFieldsSchema.description`: both are free-text project
     * documentation of comparable scale.
     */
    context: z
      .string()
      .trim()
      .max(20_000)
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    /**
     * Accepted for symmetry with the PATCH schema, but never persisted at
     * creation — `POST /api/repos` only offers detected commands as
     * `suggestedCommands`; saving one is always `PATCH /api/repos/:id`,
     * a human action taken after reviewing the suggestion.
     */
    verifyInstall: verifyCommandSchema,
    verifyBuild: verifyCommandSchema,
    verifyTest: verifyCommandSchema,
    verifyLint: verifyCommandSchema,
    verifyTimeoutSeconds: verifyTimeoutSecondsSchema,
  })
  .refine(
    (value) => value.provider !== "generic" || value.credentialRef !== undefined,
    {
      // A generic server has no conventional variable to fall back on.
      message: "A generic git server needs an explicit credential variable.",
      path: ["credentialRef"],
    },
  );
export type CreateRepoInput = z.infer<typeof createRepoSchema>;

/** `PATCH /api/repos/:id` — exactly the five verification fields, nothing else. */
export const updateVerificationCommandsSchema = z
  .object({
    verifyInstall: verifyCommandSchema,
    verifyBuild: verifyCommandSchema,
    verifyTest: verifyCommandSchema,
    verifyLint: verifyCommandSchema,
    verifyTimeoutSeconds: verifyTimeoutSecondsSchema,
  })
  .strict();
export type UpdateVerificationCommandsInput = z.infer<typeof updateVerificationCommandsSchema>;

const modelMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.string().trim().min(1));
const turnsMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.number().int().min(1).max(500));
const providersMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.enum(LLM_PROVIDER_IDS));

const quotaLimitSchema = z.object({
  /** `null` clears the limit — the bar goes back to "quota not configured". */
  limitUsd: z.number().min(0).nullable(),
  cadence: z.enum(["daily", "hourly"]),
});
const quotaLimitsSchema = z.partialRecord(
  z.enum(["subscription", "api_key"]),
  quotaLimitSchema,
);

export const updateSettingsSchema = z.object({
  models: modelMapSchema.optional(),
  providers: providersMapSchema.optional(),
  maxTurns: turnsMapSchema.optional(),
  maxParallelTasks: z.number().int().min(1).max(8).optional(),
  qaMaxCycles: z.number().int().min(0).max(10).optional(),
  autoApprovePlanForLowCriticality: z.boolean().optional(),
  noApprovalAutomation: z.boolean().optional(),
  workspaceRetentionDays: z.number().int().min(0).max(365).optional(),
  /** `null` clears the setting — keep transcripts forever. */
  transcriptRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
  theme: z.enum(THEMES).optional(),
  quotaLimits: quotaLimitsSchema.optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/** `POST /api/settings/test-provider` — which LLM backend to send `"test"` to. */
export const testProviderSchema = z.object({
  provider: z.enum(LLM_PROVIDER_IDS),
});
export type TestProviderInput = z.infer<typeof testProviderSchema>;

export const usageQuerySchema = z.object({
  /** Rolling window in days; omitted means all time. */
  days: z.coerce.number().int().min(1).max(365).optional(),
  taskId: z.string().optional(),
});
