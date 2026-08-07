"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { formatDateTime } from "@/lib/utils";

/** Provider metadata, passed from the server so the client needs no registry. */
export type ProviderOption = {
  id: string;
  displayName: string;
  defaultCredentialEnvVar: string;
  exampleUrl: string;
  /** Whether the URL pattern can be recognised automatically. */
  autoDetectable: boolean;
};

export type RepoRowView = {
  id: string;
  name: string;
  url: string;
  provider: string;
  providerName: string;
  defaultBranch: string;
  createdAt: number;
  taskCount: number;
  credential: { variable: string; present: boolean };
  /**
   * Whether free-text project documentation was entered at connection time.
   * The list payload never carries the full text — it's fetched on demand
   * from `/api/repos/:id` when a repo's context is expanded.
   */
  hasContext: boolean;
};

export function RepoManager({
  repos,
  providers,
}: {
  repos: RepoRowView[];
  providers: ProviderOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [provider, setProvider] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [credentialUsername, setCredentialUsername] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expandedContext, setExpandedContext] = useState<string | null>(null);
  const [contextText, setContextText] = useState<Record<string, string>>({});
  const [loadingContext, setLoadingContext] = useState<string | null>(null);

  const selected = useMemo(
    () => providers.find((option) => option.id === provider),
    [providers, provider],
  );
  const isGeneric = provider === "generic";

  async function addRepo(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});

    const response = await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        url,
        defaultBranch,
        provider: provider === "" ? undefined : provider,
        credentialRef: credentialRef || undefined,
        credentialUsername: credentialUsername || undefined,
        apiBaseUrl: apiBaseUrl || undefined,
        context: context || undefined,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      details?: Record<string, string>;
      warning?: string;
      verified?: boolean;
      detectedDefaultBranch?: string;
    };

    setBusy(false);

    if (!response.ok) {
      setErrors(payload.details ?? {});
      toast.error(payload.error ?? "Could not add the repository.");
      return;
    }

    setName("");
    setUrl("");
    setDefaultBranch("main");
    setCredentialRef("");
    setCredentialUsername("");
    setApiBaseUrl("");
    setContext("");

    const branchMismatch =
      payload.detectedDefaultBranch && payload.detectedDefaultBranch !== defaultBranch;
    if (payload.verified) {
      if (branchMismatch) {
        toast.info(
          `Connected, but the repository's default branch is "${payload.detectedDefaultBranch}", not "${defaultBranch}". Tasks will clone the branch you entered.`,
        );
      } else {
        toast.success("Connected and verified.");
      }
    } else {
      toast.warning(`Saved, but the access check failed: ${payload.warning ?? "unknown reason"}`);
    }
    router.refresh();
  }

  async function removeRepo(id: string) {
    setBusy(true);

    const response = await fetch(`/api/repos/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(payload.error ?? "Could not remove the repository.");
    } else {
      toast.success("Repository removed.");
    }

    setBusy(false);
    router.refresh();
  }

  async function toggleContext(id: string) {
    if (expandedContext === id) {
      setExpandedContext(null);
      return;
    }

    if (!(id in contextText)) {
      setLoadingContext(id);
      const response = await fetch(`/api/repos/${id}`);
      const payload = (await response.json().catch(() => ({}))) as {
        repo?: { context: string | null };
      };
      setContextText((current) => ({ ...current, [id]: payload.repo?.context ?? "" }));
      setLoadingContext(null);
    }

    setExpandedContext(id);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Connect a repository</CardTitle>
          <CardDescription>
            Credentials are read from environment variables at the moment a git command
            runs. Only the variable <em>name</em> is stored — never the secret, and never
            anything an agent can reach.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <form onSubmit={addRepo} className="flex flex-col gap-4">
            <Field label="Name" htmlFor="repo-name" error={errors.name}>
              <Input
                id="repo-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="acme/storefront"
                required
              />
            </Field>

            <Field
              label="Repository URL"
              htmlFor="repo-url"
              error={errors.url}
              hint={selected ? `e.g. ${selected.exampleUrl}` : undefined}
            >
              <Input
                id="repo-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/acme/storefront"
                required
              />
            </Field>

            <Field
              label="Provider"
              htmlFor="repo-provider"
              error={errors.provider}
              hint="Leave on auto-detect unless the host is self-hosted or unrecognised."
            >
              <Select
                id="repo-provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="">Detect from the URL</option>
                {providers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.displayName}
                    {option.autoDetectable ? "" : " (choose explicitly)"}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Default branch" htmlFor="repo-branch" error={errors.defaultBranch}>
              <Input
                id="repo-branch"
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                required
              />
            </Field>

            <Field
              label="Credential variable"
              htmlFor="repo-credential"
              error={errors.credentialRef}
              hint={
                selected
                  ? `Leave blank to use ${selected.defaultCredentialEnvVar}.`
                  : "Leave blank to use the provider's conventional variable."
              }
            >
              <Input
                id="repo-credential"
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value.toUpperCase())}
                placeholder={selected?.defaultCredentialEnvVar ?? "GITHUB_TOKEN"}
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="Credential username (optional)"
              htmlFor="repo-credential-user"
              error={errors.credentialUsername}
              hint="Only for credentials tied to an account name, such as a Bitbucket app password."
            >
              <Input
                id="repo-credential-user"
                value={credentialUsername}
                onChange={(event) => setCredentialUsername(event.target.value)}
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label={`API base URL${isGeneric ? "" : " (optional)"}`}
              htmlFor="repo-api-base"
              error={errors.apiBaseUrl}
              hint="Self-hosted instances only, e.g. https://git.acme.internal/api/v4"
            >
              <Input
                id="repo-api-base"
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
                placeholder="Leave blank for the provider's public API"
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="Context (optional)"
              htmlFor="repo-context"
              error={errors.context}
              hint="Describe the project's architecture, layout, and conventions. Given to the Architect and Developer (and every other stage) as a starting point instead of guessing from the diff."
            >
              <Textarea
                id="repo-context"
                value={context}
                onChange={(event) => setContext(event.target.value)}
                rows={6}
                placeholder="Next.js app router, business logic under src/server. SQLite via Drizzle. Route handlers stay thin and delegate to src/server/tasks/service.ts…"
                maxLength={20_000}
              />
            </Field>

            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add repository"}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected repositories</CardTitle>
        </CardHeader>
        <CardBody>
          {repos.length === 0 ? (
            <p className="text-xs text-muted">Nothing connected yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {repos.map((repo) => (
                <li key={repo.id} className="flex flex-wrap items-start gap-3 py-3 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{repo.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{repo.url}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      base {repo.defaultBranch} · added {formatDateTime(repo.createdAt)}
                    </p>
                    {repo.hasContext ? (
                      <>
                        <button
                          type="button"
                          className="mt-1 text-[11px] text-accent underline-offset-2 hover:underline"
                          onClick={() => toggleContext(repo.id)}
                          disabled={loadingContext === repo.id}
                        >
                          {loadingContext === repo.id
                            ? "Loading…"
                            : expandedContext === repo.id
                              ? "Hide context"
                              : "Show context"}
                        </button>
                        {expandedContext === repo.id ? (
                          <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface-raised p-2 text-[11px] text-foreground">
                            {contextText[repo.id]}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="info">{repo.providerName}</Badge>
                    <Badge
                      tone={repo.credential.present ? "success" : "warning"}
                      title={
                        repo.credential.present
                          ? `${repo.credential.variable} is set`
                          : `${repo.credential.variable} is not set in this environment`
                      }
                    >
                      {repo.credential.variable} {repo.credential.present ? "✓" : "missing"}
                    </Badge>
                    <Badge
                      tone={repo.hasContext ? "success" : "neutral"}
                      title={
                        repo.hasContext
                          ? "Agents receive this repository's context at every stage."
                          : "No context provided for this repository."
                      }
                    >
                      {repo.hasContext ? "Context ✓" : "No context"}
                    </Badge>
                    <Badge tone={repo.taskCount > 0 ? "neutral" : "neutral"}>
                      {repo.taskCount} task{repo.taskCount === 1 ? "" : "s"}
                    </Badge>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || repo.taskCount > 0}
                    title={
                      repo.taskCount > 0
                        ? "Repositories with tasks cannot be removed."
                        : undefined
                    }
                    onClick={() => removeRepo(repo.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
