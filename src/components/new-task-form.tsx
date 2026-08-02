"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { PRIORITIES, type Priority } from "@/server/pipeline/stages";

export type RepoOption = { id: string; name: string; defaultBranch: string };

/**
 * Task creation form.
 *
 * The right-hand preview shows exactly what the Stakeholder agent receives —
 * the request text and nothing else — so the user can see that a vague
 * description is all the first agent has to work with.
 */
export function NewTaskForm({ repos }: { repos: RepoOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedRepo = repos.find((repo) => repo.id === repoId);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setSubmitError(null);

    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, title, description, priority }),
    });

    const payload = (await response.json()) as {
      task?: { id: string };
      error?: string;
      details?: Record<string, string>;
    };

    if (!response.ok) {
      setErrors(payload.details ?? {});
      setSubmitError(payload.error ?? "Could not create the task.");
      return;
    }

    startTransition(() => {
      router.push(`/tasks/${payload.task!.id}`);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <Card>
        <CardHeader>
          <CardTitle>New task</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="Repository" htmlFor="repoId" error={errors.repoId}>
              <Select
                id="repoId"
                value={repoId}
                onChange={(event) => setRepoId(event.target.value)}
                required
              >
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name} ({repo.defaultBranch})
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Title"
              htmlFor="title"
              error={errors.title}
              hint="Also used for the branch name and the pull request title."
            >
              <Input
                id="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Hide archived orders from the default list"
                maxLength={160}
                required
              />
            </Field>

            <Field
              label="Description"
              htmlFor="description"
              error={errors.description}
              hint="Write it the way you would explain it to a colleague. The Stakeholder agent turns this into an unambiguous brief."
            >
              <Textarea
                id="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={12}
                placeholder="Customers with long order histories can't find recent orders. Archived orders should be hidden from the default list view but still reachable through a filter…"
                required
              />
            </Field>

            <Field label="Priority" htmlFor="priority">
              <Select
                id="priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
              >
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>

            {submitError ? <p className="text-xs text-danger">{submitError}</p> : null}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Starting…" : "Start the pipeline"}
              </Button>
              <span className="text-xs text-muted">
                The first agent starts as soon as the worker picks up the job.
              </span>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>What the Stakeholder agent receives</CardTitle>
        </CardHeader>
        <CardBody>
          <pre className="artifact-body max-h-[32rem] overflow-auto rounded-md border border-border bg-background p-3">
{`## Task

- Title: ${title || "(not set)"}
- Repository: ${selectedRepo?.name ?? "(none selected)"}
- Priority: ${priority}
- Stage: Stakeholder

## Original request

${description || "(empty)"}

## Now

Produce brief.md as described in the output contract.`}
          </pre>
          <p className="mt-3 text-xs text-muted">
            Nothing else is passed in. Each later stage receives only the artifacts the
            previous stage produced — never another agent&apos;s conversation.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
