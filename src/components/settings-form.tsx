"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import type { Cadence, ProviderAuth } from "@/server/config/env";
import { LLM_PROVIDER_IDS, LLM_PROVIDER_LABELS, type LlmProviderId } from "@/server/config/llm-providers";
import { AGENT_STAGES, STAGE_LABELS, type AgentStage } from "@/server/pipeline/stages";
import type { AppSettings } from "@/server/settings/store";

const QUOTA_MODES = [
  { mode: "subscription" as const, label: "Claude subscription" },
  { mode: "api_key" as const, label: "Anthropic API key" },
];

/**
 * Editable runtime settings: models, providers, turn ceilings, pipeline limits
 * and usage quota.
 */
export function SettingsForm({
  initial,
  llmCredentials,
}: {
  initial: AppSettings;
  llmCredentials: Record<LlmProviderId, ProviderAuth>;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings>(initial);
  const [busy, setBusy] = useState(false);

  function setModel(stage: AgentStage, value: string) {
    setSettings((current) => ({
      ...current,
      models: { ...current.models, [stage]: value },
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
    mode: "subscription" | "api_key",
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
                  <Field label="Model id" htmlFor={`model-${stage}`}>
                    <Input
                      id={`model-${stage}`}
                      value={settings.models[stage]}
                      onChange={(event) => setModel(stage, event.target.value)}
                      className="font-mono text-xs"
                    />
                  </Field>
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
        <CardBody>
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
                  </Select>
                </Field>
              </div>
            ))}
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
