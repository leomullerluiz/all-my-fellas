// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsForm } from "@/components/settings-form";
import { LLM_PROVIDER_IDS, type LlmProviderId } from "@/server/config/llm-providers";
import { PIPELINE_EVENT_TYPES } from "@/server/events/types";
import { AGENT_STAGES, type AgentStage } from "@/server/pipeline/stages";
import type { AppSettings } from "@/server/settings/store";

/**
 * S2 — the quota enforcement copy must name the pool it enforces as combined
 * across every provider, not a per-provider guarantee (spec §4.8). This is a
 * pure text assertion; enforcement *behaviour* is covered server-side in
 * `tests/admission.test.ts`.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

function stageRecord<T>(value: T): Record<AgentStage, T> {
  return Object.fromEntries(AGENT_STAGES.map((stage) => [stage, value])) as Record<AgentStage, T>;
}

const INITIAL: AppSettings = {
  models: stageRecord("claude-sonnet-5"),
  providers: stageRecord("claude"),
  maxParallelTasks: 1,
  reworkMaxCycles: 2,
  autoApprovePlanForLowCriticality: false,
  humanCodeReviewDefault: false,
  maxTurns: stageRecord(10),
  workspaceRetentionDays: 7,
  transcriptRetentionDays: null,
  theme: "system",
  quotaLimits: {
    subscription: { limitUsd: null, cadence: "daily" },
    api_key: { limitUsd: null, cadence: "daily" },
    chatgpt: { limitUsd: null, cadence: "daily" },
    gemini: { limitUsd: null, cadence: "daily" },
  },
  warningRatio: 0.8,
  quotaEnforcement: "off",
  maxCostPerStageUsd: null,
  queueHeld: false,
  notifications: {
    browser: true,
    webhookUrl: null,
    webhookSecretRef: null,
    events: Object.fromEntries(PIPELINE_EVENT_TYPES.map((type) => [type, false])) as AppSettings["notifications"]["events"],
  },
};

const LLM_CREDENTIALS = Object.fromEntries(
  LLM_PROVIDER_IDS.map((id) => [id, { mode: "missing", label: "no credential" }]),
) as unknown as Record<LlmProviderId, { mode: string; label: string }>;

describe("SettingsForm — quota enforcement copy (S2)", () => {
  it("names the pool as combined across every provider, not per-provider", () => {
    render(
      <SettingsForm
        initial={INITIAL}
        llmCredentials={LLM_CREDENTIALS as never}
        transcriptStorage={{ count: 0, totalBytes: 0 }}
      />,
    );

    expect(screen.getByText(/across every provider/i)).toBeTruthy();
    expect(screen.getByText(/not a per-provider guarantee/i)).toBeTruthy();
  });

  it("renders the three enforcement options", () => {
    render(
      <SettingsForm
        initial={INITIAL}
        llmCredentials={LLM_CREDENTIALS as never}
        transcriptStorage={{ count: 0, totalBytes: 0 }}
      />,
    );

    const select = screen.getByLabelText("Enforcement") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["off", "warn", "hold"]);
  });
});
