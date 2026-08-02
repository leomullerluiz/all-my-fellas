"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { formatDateTime } from "@/lib/utils";

export type RepoRowView = {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  createdAt: number;
  taskCount: number;
};

export function RepoManager({
  repos,
  githubTokenPresent,
}: {
  repos: RepoRowView[];
  githubTokenPresent: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: "warning" | "success"; text: string } | null>(
    null,
  );

  async function addRepo(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setNotice(null);

    const response = await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url, defaultBranch }),
    });
    const payload = (await response.json()) as {
      error?: string;
      details?: Record<string, string>;
      warning?: string;
      verified?: boolean;
    };

    setBusy(false);

    if (!response.ok) {
      setErrors(payload.details ?? {});
      setNotice({ tone: "warning", text: payload.error ?? "Could not add the repository." });
      return;
    }

    setName("");
    setUrl("");
    setDefaultBranch("main");
    setNotice(
      payload.verified
        ? { tone: "success", text: "Connected and verified." }
        : {
            tone: "warning",
            text: `Saved, but the access check failed: ${payload.warning ?? "unknown reason"}`,
          },
    );
    router.refresh();
  }

  async function removeRepo(id: string) {
    setBusy(true);
    setNotice(null);

    const response = await fetch(`/api/repos/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setNotice({ tone: "warning", text: payload.error ?? "Could not remove the repository." });
    }

    setBusy(false);
    router.refresh();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Connect a repository</CardTitle>
          <CardDescription>
            The token is read from <code className="font-mono">GITHUB_TOKEN</code> in your
            environment. It is never stored in the database and never reaches an agent.
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
            <Field label="Repository URL" htmlFor="repo-url" error={errors.url}>
              <Input
                id="repo-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/acme/storefront"
                required
              />
            </Field>
            <Field label="Default branch" htmlFor="repo-branch" error={errors.defaultBranch}>
              <Input
                id="repo-branch"
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                required
              />
            </Field>

            {!githubTokenPresent ? (
              <p className="text-xs text-warning">
                GITHUB_TOKEN is not set, so the access check will fail and delivery will not
                work until you add it.
              </p>
            ) : null}
            {notice ? (
              <p
                className={notice.tone === "success" ? "text-xs text-success" : "text-xs text-warning"}
              >
                {notice.text}
              </p>
            ) : null}

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
                <li key={repo.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{repo.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{repo.url}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      base {repo.defaultBranch} · added {formatDateTime(repo.createdAt)}
                    </p>
                  </div>
                  <Badge tone={repo.taskCount > 0 ? "info" : "neutral"}>
                    {repo.taskCount} task{repo.taskCount === 1 ? "" : "s"}
                  </Badge>
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
