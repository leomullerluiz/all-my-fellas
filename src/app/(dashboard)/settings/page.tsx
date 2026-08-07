import { ProviderTestButton } from "@/components/provider-test-button";
import { SettingsForm } from "@/components/settings-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveProviderAuth } from "@/server/config/env";
import { LLM_PROVIDER_LABELS, resolveAllLlmCredentials } from "@/server/config/llm-providers";
import { configuredCredentialVariables, conventionalEnvVars } from "@/server/git/credentials";
import { PROVIDERS, providerFor } from "@/server/git/providers";
import { getSettings } from "@/server/settings/store";
import { listRepos } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const auth = resolveProviderAuth();
  const settings = getSettings();
  const llmCredentials = resolveAllLlmCredentials();

  // One row per provider, plus any variable a connection explicitly names, so
  // a custom credential reference is visible here too.
  const repos = listRepos();
  const conventional = conventionalEnvVars(PROVIDERS).map((entry) => {
    const users = repos.filter(
      (repo) => (repo.credentialRef ?? providerFor(repo.provider).defaultCredentialEnvVar) === entry.variable,
    );
    return { ...entry, inUse: users.length > 0, count: users.length };
  });
  const custom = configuredCredentialVariables(repos.map((repo) => repo.credentialRef))
    .filter((variable) => !conventional.some((entry) => entry.variable === variable))
    .map((variable) => ({
      variable,
      present: (process.env[variable] ?? "").trim() !== "",
      inUse: true,
      count: repos.filter((repo) => repo.credentialRef === variable).length,
    }));
  const credentials = [...conventional, ...custom];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-xs text-muted">
          Values here override the defaults from <code className="font-mono">.env</code>. The
          worker reads them at the start of every job.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Claude:</span>
            <Badge tone={auth.mode === "missing" ? "danger" : "success"}>{auth.label}</Badge>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted">LLM providers (Settings → Model per role):</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(llmCredentials) as Array<keyof typeof llmCredentials>).map((id) => (
                <div key={id} className="flex items-center gap-1.5">
                  <Badge
                    tone={llmCredentials[id].mode === "missing" ? "danger" : "success"}
                    title={llmCredentials[id].label}
                  >
                    {LLM_PROVIDER_LABELS[id]} {llmCredentials[id].mode === "missing" ? "✗" : "✓"}
                  </Badge>
                  <ProviderTestButton provider={id} />
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted">Repository credentials:</span>
            <div className="flex flex-wrap gap-1.5">
              {credentials.map((entry) => (
                <Badge
                  key={entry.variable}
                  tone={entry.present ? "success" : entry.inUse ? "warning" : "neutral"}
                  title={
                    entry.inUse
                      ? `${entry.count} connection(s) read this variable`
                      : "No connection uses this provider yet"
                  }
                >
                  {entry.variable} {entry.present ? "✓" : "not set"}
                </Badge>
              ))}
            </div>
            <p className="text-[11px] text-muted">
              A connection can point at a different variable — see Repositories. Only
              variables actually in use need to be set.
            </p>
          </div>

          <div className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[11px] leading-relaxed text-muted">
            <p className="font-medium text-foreground">Billing note</p>
            <p className="mt-1">
              Subscription mode spends your Claude Pro/Max quota through the OAuth token
              produced by <code className="font-mono">claude setup-token</code>. Anthropic&apos;s
              policy on programmatic subscription use has changed more than once — check the
              current terms before depending on it for sustained runs, and switch to{" "}
              <code className="font-mono">ANTHROPIC_API_KEY</code> if you need pay-per-use
              billing. Switching modes is an environment-variable change; no code changes.
            </p>
            <p className="mt-2">
              This design assumes personal use with your own subscription. Offering
              &quot;log in with Claude&quot; to other people requires approval from Anthropic;
              third-party instances should use an API key.
            </p>
          </div>
        </CardBody>
      </Card>

      <SettingsForm initial={settings} llmCredentials={llmCredentials} />
    </div>
  );
}
