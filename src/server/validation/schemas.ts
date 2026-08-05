import { z } from "zod";

import { validateCredentialRef } from "../git/credentials";
import { PROVIDER_IDS } from "../git/providers/types";
import { AGENT_STAGES, GATES, GATE_DECISIONS, PRIORITIES, TASK_STATUSES } from "../pipeline/stages";
import { THEMES } from "../settings/store";

/**
 * Request payload schemas, shared between the route handlers and the client
 * forms so both sides validate against the same rules.
 */

/** The fields a task carries, shared by creation and editing. */
export const taskFieldsSchema = z.object({
  repoId: z.string().min(1, "Select a repository."),
  title: z.string().trim().min(3, "Give the task a title.").max(160),
  description: z
    .string()
    .trim()
    .min(20, "Describe the feature in at least 20 characters.")
    .max(20_000),
  priority: z.enum(PRIORITIES).default("medium"),
  /** Park at HUMAN_CODE_REVIEW before delivery. Not changeable after start. */
  requireHumanCodeReview: z.boolean().default(false),
});

export const createTaskSchema = taskFieldsSchema.extend({
  /**
   * Whether to enter the pipeline immediately. Defaults to false: a task left
   * sitting costs nothing, a task started by accident costs quota and a clone.
   */
  start: z.boolean().default(false),
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

const modelMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.string().trim().min(1));
const turnsMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.number().int().min(1).max(500));

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
  maxTurns: turnsMapSchema.optional(),
  maxParallelTasks: z.number().int().min(1).max(8).optional(),
  qaMaxCycles: z.number().int().min(0).max(10).optional(),
  autoApprovePlanForLowCriticality: z.boolean().optional(),
  workspaceRetentionDays: z.number().int().min(0).max(365).optional(),
  theme: z.enum(THEMES).optional(),
  quotaLimits: quotaLimitsSchema.optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const usageQuerySchema = z.object({
  /** Rolling window in days; omitted means all time. */
  days: z.coerce.number().int().min(1).max(365).optional(),
  taskId: z.string().optional(),
});
