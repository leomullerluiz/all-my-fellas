// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsForm } from "@/components/settings-form";
import { LLM_PROVIDER_IDS, MODEL_TIERS, type LlmProviderId } from "@/server/config/llm-providers";
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
  models: stageRecord({ tier: "default" as const }),
  providers: stageRecord("claude"),
  maxParallelTasks: 1,
  reworkMaxCycles: 2,
  autoApprovePlanForLowCriticality: false,
  noApprovalAutomation: false,
  humanCodeReviewDefault: false,
  codeReviewEnabled: "always",
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
  autoArchiveDays: null,
  boardRefreshMs: 4000,
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

const TIER_MODELS = {
  claude: { light: "claude-haiku-4-5", default: "claude-sonnet-5", heavy: "claude-opus-5" },
  chatgpt: { light: "gpt-4.1-mini", default: "gpt-4.1", heavy: "o3" },
  gemini: { light: "gemini-2.5-flash", default: "gemini-2.5-pro", heavy: "gemini-2.5-pro" },
};

function renderForm() {
  return render(
    <SettingsForm
      initial={INITIAL}
      llmCredentials={LLM_CREDENTIALS as never}
      transcriptStorage={{ count: 0, totalBytes: 0 }}
      tierModels={TIER_MODELS}
    />,
  );
}

describe("SettingsForm — quota enforcement copy (S2)", () => {
  it("names the pool as combined across every provider, not per-provider", () => {
    renderForm();

    expect(screen.getByText(/across every provider/i)).toBeTruthy();
    expect(screen.getByText(/not a per-provider guarantee/i)).toBeTruthy();
  });

  it("renders the three enforcement options", () => {
    renderForm();

    const select = screen.getByLabelText("Enforcement") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["off", "warn", "hold"]);
  });
});

describe("SettingsForm — tiered model picker (S3)", () => {
  it("offers light/default/heavy plus a custom option for each role", () => {
    renderForm();

    const select = screen.getByLabelText("Model", {
      selector: "#model-tier-STAKEHOLDER_REFINEMENT",
    }) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual([...MODEL_TIERS, "custom"]);
  });

  it("shows the resolved model id for the selected tier and provider", () => {
    renderForm();
    expect(screen.getAllByText(/Resolves to claude-sonnet-5 on Claude/).length).toBeGreaterThan(0);
  });

  it("reveals a literal input only once 'Custom model id…' is picked", () => {
    renderForm();
    expect(screen.queryByLabelText("Custom model id")).toBeNull();
  });

  it("warns on an unpriced custom literal for chatgpt/gemini but not for claude", () => {
    const initial: AppSettings = {
      ...INITIAL,
      providers: { ...INITIAL.providers, PO_REFINEMENT: "chatgpt", ARCHITECTURE: "claude" },
      models: {
        ...INITIAL.models,
        PO_REFINEMENT: { literal: "not-in-pricing-table" },
        ARCHITECTURE: { literal: "not-in-pricing-table-either" },
      },
    };
    render(
      <SettingsForm
        initial={initial}
        llmCredentials={LLM_CREDENTIALS as never}
        transcriptStorage={{ count: 0, totalBytes: 0 }}
        tierModels={TIER_MODELS}
      />,
    );

    expect(screen.getAllByText(/unpriced model/i).length).toBe(1);
  });
});

/**
 * S2 — enabling the "Desktop notifications" checkbox must go through
 * `Notification.requestPermission()` when permission hasn't been decided
 * yet, and must not persist the setting as enabled unless that resolves to
 * `"granted"`.
 */
describe("SettingsForm — desktop notification permission (S2)", () => {
  let requestPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestPermission = vi.fn();
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
    }
    vi.stubGlobal("Notification", FakeNotification);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderForm(browser = false) {
    render(
      <SettingsForm
        initial={{ ...INITIAL, notifications: { ...INITIAL.notifications, browser } }}
        llmCredentials={LLM_CREDENTIALS as never}
        transcriptStorage={{ count: 0, totalBytes: 0 }}
        tierModels={TIER_MODELS}
      />,
    );
    return screen.getByRole("checkbox", {
      name: /show a desktop notification the instant any task enters an approval gate/i,
    }) as HTMLInputElement;
  }

  it("calls requestPermission when enabling while permission is default", async () => {
    requestPermission.mockResolvedValue("granted");
    const checkbox = renderForm(false);

    fireEvent.click(checkbox);

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it("does not enable the setting when requestPermission resolves denied", async () => {
    requestPermission.mockResolvedValue("denied");
    const checkbox = renderForm(false);

    fireEvent.click(checkbox);

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    // Give the resolved promise's continuation a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkbox.checked).toBe(false);
  });

  it("does not call requestPermission when disabling the checkbox", async () => {
    const checkbox = renderForm(true);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
