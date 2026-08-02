import { z } from "zod";

import { AGENT_STAGES, GATES, GATE_DECISIONS, PRIORITIES, TASK_STATUSES } from "../pipeline/stages";

/**
 * Request payload schemas, shared between the route handlers and the client
 * forms so both sides validate against the same rules.
 */

export const createTaskSchema = z.object({
  repoId: z.string().min(1, "Select a repository."),
  title: z.string().trim().min(3, "Give the task a title.").max(160),
  description: z
    .string()
    .trim()
    .min(20, "Describe the feature in at least 20 characters.")
    .max(20_000),
  priority: z.enum(PRIORITIES).default("medium"),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const listTasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
});

export const gateDecisionSchema = z.object({
  decision: z.enum(GATE_DECISIONS),
  comment: z.string().trim().max(4_000).optional(),
});
export type GateDecisionInput = z.infer<typeof gateDecisionSchema>;

export const gateParamSchema = z.enum(GATES);

export const createRepoSchema = z.object({
  name: z.string().trim().min(1, "Give the connection a name.").max(120),
  url: z
    .string()
    .trim()
    .url("Enter the full https URL of the repository.")
    .refine((value) => value.includes("github.com"), {
      message: "Only github.com repositories are supported in this release.",
    }),
  defaultBranch: z.string().trim().min(1).max(120).default("main"),
});
export type CreateRepoInput = z.infer<typeof createRepoSchema>;

const modelMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.string().trim().min(1));
const turnsMapSchema = z.partialRecord(z.enum(AGENT_STAGES), z.number().int().min(1).max(500));

export const updateSettingsSchema = z.object({
  models: modelMapSchema.optional(),
  maxTurns: turnsMapSchema.optional(),
  maxParallelTasks: z.number().int().min(1).max(8).optional(),
  qaMaxCycles: z.number().int().min(0).max(10).optional(),
  autoApprovePlanForLowCriticality: z.boolean().optional(),
  workspaceRetentionDays: z.number().int().min(0).max(365).optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const usageQuerySchema = z.object({
  /** Rolling window in days; omitted means all time. */
  days: z.coerce.number().int().min(1).max(365).optional(),
  taskId: z.string().optional(),
});
