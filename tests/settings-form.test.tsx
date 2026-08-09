// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  noApprovalAutomation: false,
  humanCodeReviewDefault: false,
  maxTurns: stageRecord(10),
  workspaceRetentionDays: 7,
  transcriptRetentionDays: null,
  theme: "system",
  quotaLimits: {
    subscription: { limitUsd: null, cadence: "daily" },
    api_key: { limitUsd: null, cadence: "daily" },
  },
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
