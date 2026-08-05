import { eq } from "drizzle-orm";

import { type QuotaConfig, resolveLimits, resolveModels, resolveQuota } from "../config/env";
import { db } from "../db/client";
import { settings } from "../db/schema";
import type { AgentStage } from "../pipeline/stages";

/**
 * Runtime settings that a user can change from the Settings screen.
 *
 * The `.env` file supplies the defaults; anything the user overrides is stored
 * as a single JSON blob so adding a knob never needs a migration.
 */

const SETTINGS_KEY = "app";

/** `"system"` follows the browser's `prefers-color-scheme`; the other two are explicit. */
export const THEMES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEMES)[number];

export type AppSettings = {
  /** Model id per agent stage. */
  models: Record<AgentStage, string>;
  maxParallelTasks: number;
  /**
   * Maximum rework cycles, shared by every reviewer that can send work back to
   * the Developer: code review, QA and a human `request_changes`.
   */
  reworkMaxCycles: number;
  /** Skip the human plan gate when the Architect rates criticality as low. */
  autoApprovePlanForLowCriticality: boolean;
  /** Pre-selected value of "require human code review" on the new-task form. */
  humanCodeReviewDefault: boolean;
  /** Per-stage turn ceiling; caps the cost of a runaway agent. */
  maxTurns: Record<AgentStage, number>;
  workspaceRetentionDays: number;
  /** Dark/Light/System palette for the dashboard UI. */
  theme: Theme;
  /**
   * User-entered usage quota per Claude auth mode, shown by the dashboard's
   * usage bar. There is no API to read the real Pro/Max or pay-per-use quota,
   * so this is always a configured value, never a fetched one.
   */
  quotaLimits: QuotaConfig;
};

export function defaultSettings(): AppSettings {
  const models = resolveModels();
  const limits = resolveLimits();
  return {
    models: {
      STAKEHOLDER_REFINEMENT: models.light,
      PO_REFINEMENT: models.default,
      ARCHITECTURE: models.default,
      DEVELOPMENT: models.default,
      CODE_REVIEW: models.default,
      QA: models.default,
      PO_HOMOLOGATION: models.light,
    },
    maxParallelTasks: limits.maxParallelTasks,
    reworkMaxCycles: limits.reworkMaxCycles,
    autoApprovePlanForLowCriticality: false,
    // The pipeline already has two mandatory human gates; a third by default
    // would triple the interaction cost of every task.
    humanCodeReviewDefault: false,
    maxTurns: {
      STAKEHOLDER_REFINEMENT: 6,
      PO_REFINEMENT: 12,
      ARCHITECTURE: 30,
      DEVELOPMENT: 80,
      // Reading a diff should not need more; a reviewer that hits the ceiling
      // is exploring the repository instead of reviewing the change.
      CODE_REVIEW: 40,
      QA: 40,
      PO_HOMOLOGATION: 10,
    },
    workspaceRetentionDays: limits.workspaceRetentionDays,
    theme: "system",
    quotaLimits: resolveQuota(),
  };
}

/** Reads the effective settings: env defaults merged with stored overrides. */
export function getSettings(): AppSettings {
  const base = defaultSettings();
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  if (!row) return base;

  let stored: Partial<AppSettings>;
  try {
    stored = JSON.parse(row.value) as Partial<AppSettings>;
  } catch {
    // A hand-edited or truncated row should not take the app down.
    return base;
  }

  return {
    ...base,
    ...stored,
    models: { ...base.models, ...(stored.models ?? {}) },
    maxTurns: { ...base.maxTurns, ...(stored.maxTurns ?? {}) },
    quotaLimits: {
      ...base.quotaLimits,
      ...(stored.quotaLimits ?? {}),
    },
  };
}

/**
 * A partial update. The record fields are themselves partial so a caller can
 * change one role's model (or one auth mode's quota) without resending the
 * whole map.
 */
export type SettingsPatch = Partial<Omit<AppSettings, "models" | "maxTurns" | "quotaLimits">> & {
  models?: Partial<Record<AgentStage, string>>;
  maxTurns?: Partial<Record<AgentStage, number>>;
  quotaLimits?: Partial<QuotaConfig>;
};

/** Merges `patch` into the stored overrides and returns the new effective settings. */
export function updateSettings(patch: SettingsPatch): AppSettings {
  const current = getSettings();
  const merged: AppSettings = {
    ...current,
    ...patch,
    models: { ...current.models, ...(patch.models ?? {}) },
    maxTurns: { ...current.maxTurns, ...(patch.maxTurns ?? {}) },
    quotaLimits: {
      ...current.quotaLimits,
      ...(patch.quotaLimits ?? {}),
    },
  };

  db.insert(settings)
    .values({ key: SETTINGS_KEY, value: JSON.stringify(merged) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(merged) },
    })
    .run();

  return merged;
}
