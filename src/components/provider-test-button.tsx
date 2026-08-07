"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { LLM_PROVIDER_LABELS, type LlmProviderId } from "@/server/config/llm-providers";

/**
 * Sends the literal message `"test"` to one LLM provider and toasts the
 * reply — a live diagnostic distinct from the credential-presence badges
 * next to it, which only reflect whether an env var is set.
 *
 * Each instance owns its own `busy` state, so testing one provider never
 * disables another's control (S3).
 */
export function ProviderTestButton({ provider }: { provider: LlmProviderId }) {
  const [busy, setBusy] = useState(false);
  const label = LLM_PROVIDER_LABELS[provider];

  async function runTest() {
    setBusy(true);

    try {
      const response = await fetch("/api/settings/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });

      const payload = (await response.json()) as { text?: string; error?: string };

      if (!response.ok) {
        toast.error(payload.error ?? `Could not test ${label}.`);
        return;
      }

      toast.success(`${label} responded: ${payload.text}`);
    } catch {
      toast.error(`Could not reach the server to test ${label}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={runTest}>
      {busy ? "Testing…" : "Test connection"}
    </Button>
  );
}
