import { SettingsForm } from "@/components/settings-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { hasGithubToken, resolveProviderAuth } from "@/server/config/env";
import { getSettings } from "@/server/settings/store";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const auth = resolveProviderAuth();
  const settings = getSettings();

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
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">GitHub:</span>
            <Badge tone={hasGithubToken() ? "success" : "warning"}>
              {hasGithubToken() ? "GITHUB_TOKEN present" : "GITHUB_TOKEN missing"}
            </Badge>
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

      <SettingsForm initial={settings} />
    </div>
  );
}
