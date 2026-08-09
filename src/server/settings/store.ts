import { eq } from "drizzle-orm";

import { type QuotaConfig, resolveLimits, resolveModels, resolveQuota } from "../config/env";
import type { LlmProviderId } from "../config/llm-providers";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { PIPELINE_EVENT_TYPES, type PipelineEvent } from "../events/types";
import type { AgentStage } from "../pipeline/stages";
import type { QuotaEnforcement } from "../usage/quota";

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

/** Per-event-type opt-in for the webhook dispatcher (§8.4). */
export type NotificationEventToggles = Record<PipelineEvent["type"], boolean>;

export type NotificationSettings = {
  /** Whether the browser should request permission and show desktop notifications. */
  browser: boolean;
  webhookUrl: string | null;
  /**
   * The environment variable *name* the shared secret is read from, never
   * the value — same indirection every other credential in this product
   * uses (`repos.credential_ref`). `null` means the webhook is unsigned.
   */
  webhookSecretRef: string | null;
  events: NotificationEventToggles;
};

/**
 * Notifying on everything trains the user to ignore it (§8.4) — only the
 * subset where a human is either blocked or has to decide starts enabled.
 */
const DEFAULT_NOTIFIED_EVENTS: ReadonlySet<PipelineEvent["type"]> = new Set([
  "gate_opened",
  "task_finished",
  "pr_opened",
  "quota_warning",
]);

function defaultNotificationEvents(): NotificationEventToggles {
  const toggles = {} as NotificationEventToggles;
  for (const type of PIPELINE_EVENT_TYPES) toggles[type] = DEFAULT_NOTIFIED_EVENTS.has(type);
  return toggles;
}

export type AppSettings = {
  /** Model id per agent stage. */
  models: Record<AgentStage, string>;
  /**
   * LLM backend per agent stage. Defaults to `"claude"` everywhere, which is
   * what keeps an install that has never touched this field behaving exactly
   * as it did before ChatGPT/Gemini support existed.
   */
  providers: Record<AgentStage, LlmProviderId>;
  maxParallelTasks: number;
  /**
   * Maximum rework cycles, shared by every reviewer that can send work back to
   * the Developer: code review, QA, a human `request_changes` and — once —
   * PO_HOMOLOGATION.
   */
  reworkMaxCycles: number;
  /** Skip the human plan gate when the Architect rates criticality as low. */
  autoApprovePlanForLowCriticality: boolean;
  /**
   * Instance-wide kill switch for `PLAN_GATE` and `STAKEHOLDER_GATE`: when
   * enabled, every task skips both, running straight through to `DELIVERY`
   * without a human ever approving the plan or the final PR. The
   * `PO_HOMOLOGATION` escalation branch (second rejection, or the rework
   * budget exhausted) still parks on `STAKEHOLDER_GATE` regardless — see
   * `state-machine.ts`. Defaults to `false`; there is no per-user or
   * per-project scoping, since the codebase has no such model.
   */
  noApprovalAutomation: boolean;
  /** Pre-selected value of "require human code review" on the new-task form. */
  humanCodeReviewDefault: boolean;
  /**
   * Whether `CODE_REVIEW` runs at all. `"auto"` skips it when the Architect
   * rated the task `difficulty: "S"` and `criticality: "low"` — the same two
   * fields the plan gate already keys on. `"always"` reproduces today's
   * behaviour and is the default so an install that has never touched this
   * setting is unaffected.
   */
  codeReviewEnabled: "always" | "auto" | "never";
  /** Per-stage turn ceiling; caps the cost of a runaway agent. */
  maxTurns: Record<AgentStage, number>;
  workspaceRetentionDays: number;
  /** Days to keep full transcripts. `null` keeps them forever. See spec-audit-trail.md §11. */
  transcriptRetentionDays: number | null;
  /** Dark/Light/System palette for the dashboard UI. */
  theme: Theme;
  /**
   * User-entered usage quota per Claude auth mode, shown by the dashboard's
   * usage bar. There is no API to read the real Pro/Max or pay-per-use quota,
   * so this is always a configured value, never a fetched one.
   */
  quotaLimits: QuotaConfig;
  /**
   * How a configured quota limit is enforced when a task tries to enter the
   * pipeline — see `usage/quota.ts`'s `QuotaEnforcement` and
   * `orchestrator.ts`'s `assertWithinQuota`. Defaults to `"off"` so an
   * existing installation's behaviour is unchanged until it opts in.
   */
  quotaEnforcement: QuotaEnforcement;
  /**
   * Per-stage dollar ceiling, checked by every LLM provider while a session
   * runs (a stop-loss, not a hard cap — the check happens after the turn that
   * crosses it). `null` means no ceiling. See `spec-execution-honesty.md`'s
   * §3 counterpart and `techplan.md`'s S3.
   */
  maxCostPerStageUsd: number | null;
  /** "Stop starting things" (§9.2) — the worker's `tick()` claims no new jobs while set. */
  queueHeld: boolean;
  notifications: NotificationSettings;
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
    providers: {
      STAKEHOLDER_REFINEMENT: "claude",
      PO_REFINEMENT: "claude",
      ARCHITECTURE: "claude",
      DEVELOPMENT: "claude",
      CODE_REVIEW: "claude",
      QA: "claude",
      PO_HOMOLOGATION: "claude",
    },
    maxParallelTasks: limits.maxParallelTasks,
    reworkMaxCycles: limits.reworkMaxCycles,
    autoApprovePlanForLowCriticality: false,
    // The pipeline already has two mandatory human gates; a third by default
    // would triple the interaction cost of every task.
    humanCodeReviewDefault: false,
    codeReviewEnabled: "always",
    // Off by default: skipping both approval gates instance-wide is a
    // deliberate, explicit opt-in, not something a fresh install should do.
    noApprovalAutomation: false,
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
    transcriptRetentionDays: limits.transcriptRetentionDays,
    theme: "system",
    quotaLimits: resolveQuota(),
    quotaEnforcement: "off",
    maxCostPerStageUsd: null,
    queueHeld: false,
    notifications: {
      browser: true,
      webhookUrl: null,
      webhookSecretRef: null,
      events: defaultNotificationEvents(),
    },
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
    // A settings row saved before `providers` existed has no such key, so the
    // merge falls all the way back to `base` (every stage on `"claude"`) —
    // this is the one line backward compatibility hinges on.
    providers: { ...base.providers, ...(stored.providers ?? {}) },
    maxTurns: { ...base.maxTurns, ...(stored.maxTurns ?? {}) },
    quotaLimits: {
      ...base.quotaLimits,
      ...(stored.quotaLimits ?? {}),
    },
    notifications: {
      ...base.notifications,
      ...(stored.notifications ?? {}),
      events: { ...base.notifications.events, ...(stored.notifications?.events ?? {}) },
    },
  };
}

/**
 * A partial update. The record fields are themselves partial so a caller can
 * change one role's model/provider (or one auth mode's quota) without
 * resending the whole map.
 */
export type SettingsPatch = Partial<
  Omit<AppSettings, "models" | "providers" | "maxTurns" | "quotaLimits" | "notifications">
> & {
  models?: Partial<Record<AgentStage, string>>;
  providers?: Partial<Record<AgentStage, LlmProviderId>>;
  maxTurns?: Partial<Record<AgentStage, number>>;
  quotaLimits?: Partial<QuotaConfig>;
  notifications?: Partial<Omit<NotificationSettings, "events">> & {
    events?: Partial<NotificationEventToggles>;
  };
};

/** Merges `patch` into the stored overrides and returns the new effective settings. */
export function updateSettings(patch: SettingsPatch): AppSettings {
  const current = getSettings();
  const merged: AppSettings = {
    ...current,
    ...patch,
    models: { ...current.models, ...(patch.models ?? {}) },
    providers: { ...current.providers, ...(patch.providers ?? {}) },
    maxTurns: { ...current.maxTurns, ...(patch.maxTurns ?? {}) },
    quotaLimits: {
      ...current.quotaLimits,
      ...(patch.quotaLimits ?? {}),
    },
    notifications: {
      ...current.notifications,
      ...(patch.notifications ?? {}),
      events: { ...current.notifications.events, ...(patch.notifications?.events ?? {}) },
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
