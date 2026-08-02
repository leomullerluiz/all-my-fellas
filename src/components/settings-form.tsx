"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { AGENT_STAGES, STAGE_LABELS, type AgentStage } from "@/server/pipeline/stages";
import type { AppSettings } from "@/server/settings/store";

/** Editable runtime settings: models, turn ceilings and pipeline limits. */
export function SettingsForm({ initial }: { initial: AppSettings }) {
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setModel(stage: AgentStage, value: string) {
    setSettings((current) => ({
      ...current,
      models: { ...current.models, [stage]: value },
    }));
  }

  function setTurns(stage: AgentStage, value: number) {
    setSettings((current) => ({
      ...current,
      maxTurns: { ...current.maxTurns, [stage]: value },
    }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);

    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not save the settings.");
      return;
    }

    setNotice("Saved. The worker picks the new values up on its next job.");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Model per role</CardTitle>
          <CardDescription>
            Light roles produce text only; the Developer benefits most from a stronger model.
            Any Claude model id is accepted.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            {AGENT_STAGES.map((stage) => (
              <Field key={stage} label={STAGE_LABELS[stage]} htmlFor={`model-${stage}`}>
                <Input
                  id={`model-${stage}`}
                  value={settings.models[stage]}
                  onChange={(event) => setModel(stage, event.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
            ))}
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

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
        {notice ? <span className="text-xs text-success">{notice}</span> : null}
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
    </form>
  );
}
