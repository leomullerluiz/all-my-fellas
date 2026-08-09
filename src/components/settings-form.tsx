"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import type { Cadence, ProviderAuth, QuotaKey } from "@/server/config/env";
import {
  LLM_PROVIDER_IDS,
  LLM_PROVIDER_LABELS,
  MODEL_TIERS,
  type LlmProviderId,
  type ModelSelection,
  type ModelTier,
} from "@/server/config/llm-providers";
import { PIPELINE_EVENT_TYPES, type PipelineEvent } from "@/server/events/types";
import { AGENT_STAGES, STAGE_LABELS, type AgentStage } from "@/server/pipeline/stages";
import { PRICING } from "@/server/pipeline/providers/pricing";
import type { AppSettings } from "@/server/settings/store";
import type { TranscriptStorageStats } from "@/server/tasks/service";
import { formatBytes } from "@/lib/utils";

const QUOTA_MODES = [
  { mode: "subscription" as const, label: "Claude subscription" },
  { mode: "api_key" as const, label: "Anthropic API key" },
  { mode: "chatgpt" as const, label: "ChatGPT (OpenAI)" },
  { mode: "gemini" as const, label: "Gemini (Google)" },
];

const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  light: "Light",
  default: "Default",
  heavy: "Heavy",
};

/** `"custom"` is the picker's own sentinel for the `{ literal }` escape hatch — not a stored value. */
const CUSTOM_MODEL_OPTION = "custom" as const;

/**
 * Editable runtime settings: models, providers, turn ceilings, pipeline limits
 * and usage quota.
 */
export function SettingsForm({
  initial,
  llmCredentials,
  transcriptStorage,
  tierModels,
}: {
  initial: AppSettings;
  llmCredentials: Record<LlmProviderId, ProviderAuth>;
  transcriptStorage: TranscriptStorageStats;
  /** Per-provider model id for each tier — resolved server-side (§6.2/S3), since Claude's column reads `.env`. */
  tierModels: Record<LlmProviderId, Record<ModelTier, string>>;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);

  function setModel(stage: AgentStage, selection: ModelSelection) {
    setSettings((current) => ({
      ...current,
      models: { ...current.models, [stage]: selection },
    }));
  }

  function setProvider(stage: AgentStage, value: LlmProviderId) {
    setSettings((current) => ({
      ...current,
      providers: { ...current.providers, [stage]: value },
    }));
  }

  function setTurns(stage: AgentStage, value: number) {
    setSettings((current) => ({
      ...current,
      maxTurns: { ...current.maxTurns, [stage]: value },
    }));
  }

  function setQuota(
    mode: QuotaKey,
    patch: Partial<{ limitUsd: number | null; cadence: Cadence }>,
  ) {
    setSettings((current) => ({
      ...current,
      quotaLimits: {
        ...current.quotaLimits,
        [mode]: { ...current.quotaLimits[mode], ...patch },
      },
    }));
  }

  function setNotification(patch: Partial<Omit<AppSettings["notifications"], "events">>) {
    setSettings((current) => ({
      ...current,
      notifications: { ...current.notifications, ...patch },
    }));
  }

  function toggleNotificationEvent(type: PipelineEvent["type"], enabled: boolean) {
    setSettings((current) => ({
      ...current,
      notifications: {
        ...current.notifications,
        events: { ...current.notifications.events, [type]: enabled },
      },
    }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      toast.error(payload.error ?? "Could not save the settings.");
      return;
    }

    toast.success("Saved. The worker picks the new values up on its next job.");
    router.refresh();
  }

  async function runVacuum() {
    setVacuuming(true);
    const response = await fetch("/api/settings/vacuum", { method: "POST" });
    setVacuuming(false);

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      toast.error(payload.error ?? "Could not run VACUUM.");
      return;
    }
    toast.success("VACUUM complete.");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Provider and model per role</CardTitle>
          <CardDescription>
            Claude stays the default for every role — switching a role to ChatGPT or Gemini is
            opt-in. The model id must match whichever provider is selected for that role; see{" "}
            <code className="font-mono">docs/llm-providers.md</code> for accepted ids.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            {AGENT_STAGES.map((stage) => {
              const provider = settings.providers[stage];
              const credential = llmCredentials[provider];
              const selection = settings.models[stage];
              const isCustom = "literal" in selection;
              const literalValue = isCustom ? selection.literal : "";
              const pickerValue = isCustom ? CUSTOM_MODEL_OPTION : selection.tier;
              const resolvedModelId = isCustom ? selection.literal : tierModels[provider][selection.tier];
              // Claude's cost comes from the SDK's own `total_cost_usd`, not this
              // table, so there is no price to show and no "$0 forever" failure
              // mode to warn about — §5.3/§6.3.
              const pricing = provider === "claude" ? null : PRICING[resolvedModelId];
              const showPriceWarning = provider !== "claude" && !pricing;

              return (
                <div key={stage} className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">{STAGE_LABELS[stage]}</span>
                    {credential.mode === "missing" ? (
                      <Badge tone="danger" title={credential.label}>
                        credential missing
                      </Badge>
                    ) : null}
                  </div>
                  <Field label="Provider" htmlFor={`provider-${stage}`}>
                    <Select
                      id={`provider-${stage}`}
                      value={provider}
                      onChange={(event) => setProvider(stage, event.target.value as LlmProviderId)}
                    >
                      {LLM_PROVIDER_IDS.map((id) => (
                        <option key={id} value={id}>
                          {LLM_PROVIDER_LABELS[id]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="Model"
                    htmlFor={`model-tier-${stage}`}
                    hint={
                      isCustom
                        ? undefined
                        : `Resolves to ${resolvedModelId} on ${LLM_PROVIDER_LABELS[provider]}.`
                    }
                  >
                    <Select
                      id={`model-tier-${stage}`}
                      value={pickerValue}
                      onChange={(event) => {
                        const value = event.target.value;
                        setModel(
                          stage,
                          value === CUSTOM_MODEL_OPTION
                            ? { literal: resolvedModelId }
                            : { tier: value as ModelTier },
                        );
                      }}
                    >
                      {MODEL_TIERS.map((tier) => (
                        <option key={tier} value={tier}>
                          {MODEL_TIER_LABELS[tier]}
                        </option>
                      ))}
                      <option value={CUSTOM_MODEL_OPTION}>Custom model id…</option>
                    </Select>
                  </Field>
                  {isCustom ? (
                    <Field label="Custom model id" htmlFor={`model-literal-${stage}`}>
                      <Input
                        id={`model-literal-${stage}`}
                        value={literalValue}
                        onChange={(event) => setModel(stage, { literal: event.target.value })}
                        className="font-mono text-xs"
                      />
                    </Field>
                  ) : null}
                  {pricing ? (
                    <p className="text-[11px] text-muted">
                      ${pricing.inputPerMillion.toFixed(2)}/M in · ${pricing.outputPerMillion.toFixed(2)}/M out
                      (approximate, edited manually)
                    </p>
                  ) : provider === "claude" ? (
                    <p className="text-[11px] text-muted">
                      Priced from the SDK&apos;s own reported cost — no table to show here.
                    </p>
                  ) : null}
                  {showPriceWarning ? (
                    <Badge tone="warning" title="This model id is not in pricing.ts, so its cost will always report $0.">
                      unpriced model — cost will show $0
                    </Badge>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Turn ceiling per role</CardTitle>
          <CardDescription>
            The hard cap on agent turns for one stage run. This is the main brake on the cost
            of a stage that goes in circles.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            {AGENT_STAGES.map((stage) => (
              <Field key={stage} label={STAGE_LABELS[stage]} htmlFor={`turns-${stage}`}>
                <Input
                  id={`turns-${stage}`}
                  type="number"
                  min={1}
                  max={500}
                  value={settings.maxTurns[stage]}
                  onChange={(event) => setTurns(stage, Number(event.target.value))}
                />
              </Field>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pipeline limits</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Parallel tasks"
              htmlFor="maxParallelTasks"
              hint="Keep this at 1 on a Claude subscription — one pipeline already consumes a lot of quota."
            >
              <Input
                id="maxParallelTasks"
                type="number"
                min={1}
                max={8}
                value={settings.maxParallelTasks}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    maxParallelTasks: Number(event.target.value),
                  }))
                }
              />
            </Field>

            <Field
              label="Rework cycles"
              htmlFor="reworkMaxCycles"
              hint="How many times code review, QA or your own review may send work back to the Developer before the task fails. The budget is shared between all three."
            >
              <Input
                id="reworkMaxCycles"
                type="number"
                min={0}
                max={10}
                value={settings.reworkMaxCycles}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    reworkMaxCycles: Number(event.target.value),
                  }))
                }
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Human code review</span>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={settings.humanCodeReviewDefault}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      humanCodeReviewDefault: event.target.checked,
                    }))
                  }
                />
                <span>
                  Tick <strong>Require human code review</strong> by default on new tasks.
                  It stays a per-task choice either way.
                </span>
              </label>
            </div>

            <Field
              label="Spend ceiling per stage (USD)"
              htmlFor="maxCostPerStageUsd"
              hint={
                "No single agent session should ever exceed this. Checked after the turn that " +
                "crosses it, not before — a stop-loss, not a hard cap, since no provider reports " +
                "what a turn will cost before running it. The Claude figure is the SDK's own " +
                "estimate of equivalent API spend, not a bill. Blank means no ceiling."
              }
            >
              <Input
                id="maxCostPerStageUsd"
                type="number"
                min={0}
                step="0.01"
                value={settings.maxCostPerStageUsd ?? ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  setSettings((current) => ({
                    ...current,
                    maxCostPerStageUsd: raw === "" ? null : Number(raw),
                  }));
                }}
              />
            </Field>

            <Field
              label="Workspace retention (days)"
              htmlFor="workspaceRetentionDays"
              hint="How long a finished task's clone is kept on disk for inspection. 0 deletes it immediately."
            >
              <Input
                id="workspaceRetentionDays"
                type="number"
                min={0}
                max={365}
                value={settings.workspaceRetentionDays}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    workspaceRetentionDays: Number(event.target.value),
                  }))
                }
              />
            </Field>

            <Field
              label="Transcript retention (days)"
              htmlFor="transcriptRetentionDays"
              hint="How long full agent transcripts are kept before being replaced with a tombstone. Blank keeps them forever — the default, since a transcript cannot be reconstructed once pruned."
            >
              <Input
                id="transcriptRetentionDays"
                type="number"
                min={0}
                max={3650}
                value={settings.transcriptRetentionDays ?? ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  setSettings((current) => ({
                    ...current,
                    transcriptRetentionDays: raw === "" ? null : Number(raw),
                  }));
                }}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Automatic plan gate</span>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={settings.autoApprovePlanForLowCriticality}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      autoApprovePlanForLowCriticality: event.target.checked,
                    }))
                  }
                />
                <span>
                  Skip the human plan gate when the Architect rates criticality as{" "}
                  <strong>low</strong>. The final delivery gate always stays manual.
                </span>
              </label>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage quota</CardTitle>
          <CardDescription>
            Neither Claude subscription nor API-key quota is exposed by an API the pipeline can
            read, so this is a limit you type in yourself. The dashboard usage bar compares
            actual spend against it and warns as usage approaches it. Leave the limit blank to
            turn the quota display off for that mode.
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <Field
            label="Enforcement"
            htmlFor="quotaEnforcement"
            hint={
              'This enforces one combined limit across every provider (Claude, ChatGPT, Gemini), ' +
              'not a per-provider guarantee — see the note in docs. "Off" only shows the bar; ' +
              '"Warn" starts anyway and logs it; "Hold" refuses new starts once the limit is reached ' +
              '(a "Start anyway" button still overrides it per task).'
            }
          >
            <Select
              id="quotaEnforcement"
              value={settings.quotaEnforcement}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  quotaEnforcement: event.target.value as AppSettings["quotaEnforcement"],
                }))
              }
            >
              <option value="off">Off — display only</option>
              <option value="warn">Warn — start anyway, log it</option>
              <option value="hold">Hold — refuse new starts</option>
            </Select>
          </Field>

          <Field
            label="Warning threshold"
            htmlFor="warningRatio"
            hint="How close usage must get to a provider's limit before the bar switches to its warning state. 0.8 means 80%."
          >
            <Input
              id="warningRatio"
              type="number"
              min={0}
              max={1}
              step="0.01"
              value={settings.warningRatio}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  warningRatio: Number(event.target.value),
                }))
              }
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            {QUOTA_MODES.map(({ mode, label }) => (
              <div key={mode} className="flex flex-col gap-3 rounded-md border border-border p-3">
                <span className="text-xs font-medium">{label}</span>
                <Field
                  label="Limit (USD)"
                  htmlFor={`quota-limit-${mode}`}
                  hint="Blank disables the quota display for this mode."
                >
                  <Input
                    id={`quota-limit-${mode}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={settings.quotaLimits[mode].limitUsd ?? ""}
                    onChange={(event) => {
                      const raw = event.target.value;
                      setQuota(mode, { limitUsd: raw === "" ? null : Number(raw) });
                    }}
                  />
                </Field>
                <Field label="Resets" htmlFor={`quota-cadence-${mode}`}>
                  <Select
                    id={`quota-cadence-${mode}`}
                    value={settings.quotaLimits[mode].cadence}
                    onChange={(event) =>
                      setQuota(mode, { cadence: event.target.value as Cadence })
                    }
                  >
                    <option value="daily">Daily</option>
                    <option value="hourly">Hourly</option>
                    <option value="monthly">Monthly</option>
                  </Select>
                </Field>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcript storage</CardTitle>
          <CardDescription>
            {transcriptStorage.count} transcript{transcriptStorage.count === 1 ? "" : "s"} ·{" "}
            {formatBytes(transcriptStorage.totalBytes)} in <code className="font-mono">agent_runs</code>.
            The retention sweep above (if configured) replaces old transcripts with a tombstone; this
            button rewrites the database file to reclaim the freed space.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <Button type="button" variant="secondary" disabled={vacuuming} onClick={() => void runVacuum()}>
            {vacuuming ? "Running VACUUM…" : "Run VACUUM"}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications and queue</CardTitle>
          <CardDescription>
            A configured webhook receives one POST per enabled event — Slack, Discord, ntfy, n8n
            or your own script all take a plain webhook, so there is no per-vendor integration
            here. Delivery is fire-and-forget: a failure is logged and retried, never blocks the
            pipeline. Browser notifications ride the board-wide event stream instead.
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <Field
            label="Webhook URL"
            htmlFor="webhookUrl"
            hint="Blank disables the webhook entirely."
          >
            <Input
              id="webhookUrl"
              type="url"
              placeholder="https://example.com/hooks/pipeline"
              value={settings.notifications.webhookUrl ?? ""}
              onChange={(event) =>
                setNotification({ webhookUrl: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>

          <Field
            label="Signing secret (env var name)"
            htmlFor="webhookSecretRef"
            hint={
              'The NAME of an environment variable holding the secret, never the value itself — ' +
              "same rule every repository credential in this product follows. When set, deliveries " +
              "carry an X-Signature: sha256=<hmac> header over the raw body. Blank ships unsigned."
            }
          >
            <Input
              id="webhookSecretRef"
              placeholder="PIPELINE_WEBHOOK_SECRET"
              className="font-mono text-xs"
              value={settings.notifications.webhookSecretRef ?? ""}
              onChange={(event) =>
                setNotification({ webhookSecretRef: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Events</span>
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-3">
              {PIPELINE_EVENT_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={settings.notifications.events[type]}
                    onChange={(event) => toggleNotificationEvent(type, event.target.checked)}
                  />
                  <span className="font-mono">{type}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <span className="text-xs font-medium text-muted">Queue hold</span>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.queueHeld}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, queueHeld: event.target.checked }))
                }
              />
              <span>
                Stop the worker from claiming any <strong>new</strong> job. A job already running
                finishes normally — this does not abort anything in flight.
              </span>
            </label>
          </div>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
