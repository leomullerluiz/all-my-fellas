"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { PRIORITIES, type Priority } from "@/server/pipeline/stages";

export type RepoOption = { id: string; name: string; defaultBranch: string };

export type TaskFormValues = {
  repoId: string;
  title: string;
  description: string;
  priority: Priority;
  requireHumanCodeReview: boolean;
};

export type TaskFormProps = {
  repos: RepoOption[];
  /** `create` posts a new task; `edit` patches an existing, not-yet-started one. */
  mode?: "create" | "edit";
  taskId?: string;
  initial?: Partial<TaskFormValues>;
  /** Whether a concurrency slot is free, for the "Start now" button. */
  capacity?: { slotAvailable: boolean; limit: number; blocking: Array<{ title: string }> };
};

/**
 * Task creation and editing form.
 *
 * The right-hand preview shows exactly what the Stakeholder agent receives —
 * the request text and nothing else — so the user can see that a vague
 * description is all the first agent has to work with.
 */
export function NewTaskForm({
  repos,
  mode = "create",
  taskId,
  initial,
  capacity = { slotAvailable: true, limit: 1, blocking: [] },
}: TaskFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [repoId, setRepoId] = useState(initial?.repoId ?? repos[0]?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "medium");
  const [requireHumanCodeReview, setRequireHumanCodeReview] = useState(
    initial?.requireHumanCodeReview ?? false,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"queue" | "start" | null>(null);

  const selectedRepo = repos.find((repo) => repo.id === repoId);
  const isEdit = mode === "edit";

  const blockedReason = capacity.slotAvailable
    ? null
    : `Limit of ${capacity.limit} task${capacity.limit === 1 ? "" : "s"} in progress reached` +
      (capacity.blocking[0] ? ` — ${capacity.blocking[0].title} is still running.` : ".");

  async function submit(start: boolean) {
    setErrors({});
    setSubmitError(null);
    setSubmitting(start ? "start" : "queue");

    const body = {
      repoId,
      title,
      description,
      priority,
      requireHumanCodeReview,
      ...(isEdit ? {} : { start }),
    };
    const response = await fetch(isEdit ? `/api/tasks/${taskId}` : "/api/tasks", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      task?: { id: string };
      error?: string;
      details?: Record<string, string>;
    };

    setSubmitting(null);

    if (!response.ok) {
      setErrors(payload.details ?? {});
      setSubmitError(
        payload.error ?? (isEdit ? "Could not save the task." : "Could not create the task."),
      );
      // A capacity refusal on "Start now" still created the task, so send the
      // user to it rather than stranding them on a form they already submitted.
      if (response.status === 409 && payload.task) {
        startTransition(() => {
          router.push(`/tasks/${payload.task!.id}`);
          router.refresh();
        });
      }
      return;
    }

    const destination =
      isEdit || start ? `/tasks/${taskId ?? payload.task!.id}` : "/";
    startTransition(() => {
      router.push(destination);
      router.refresh();
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    void submit(false);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <Card>
        <CardHeader>
          <CardTitle>{isEdit ? "Edit task" : "New task"}</CardTitle>
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

            {/* A process choice, so it sits with priority rather than with the
                description, which is the request itself. */}
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={requireHumanCodeReview}
                onChange={(event) => setRequireHumanCodeReview(event.target.checked)}
              />
              <span>
                <span className="font-medium text-foreground">
                  Require human code review before delivery
                </span>
                <span className="mt-0.5 block text-muted">
                  After QA passes, the task waits for you to read the diff and approve it.
                </span>
              </span>
            </label>

            {submitError ? <p className="text-xs text-danger">{submitError}</p> : null}

            {isEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={pending || submitting !== null}>
                  {submitting ? "Saving…" : "Save changes"}
                </Button>
                <span className="text-xs text-muted">
                  Only tasks that have not started can be edited.
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Queueing is the default and the primary action: a task left
                      sitting costs nothing, a task started by accident costs
                      quota and a clone on disk. */}
                  <Button type="submit" disabled={pending || submitting !== null}>
                    {submitting === "queue" ? "Adding…" : "Add to queue"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending || submitting !== null || !capacity.slotAvailable}
                    title={blockedReason ?? undefined}
                    onClick={() => void submit(true)}
                  >
                    {submitting === "start" ? "Starting…" : "Start now"}
                  </Button>
                </div>
                <p className="text-xs text-muted">
                  {blockedReason
                    ? `${blockedReason} You can still add the task to the queue.`
                    : "Queued tasks wait in the Created column until you start them."}
                </p>
              </div>
            )}
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
