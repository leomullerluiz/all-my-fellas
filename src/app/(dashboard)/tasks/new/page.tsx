import Link from "next/link";
import { notFound } from "next/navigation";

import { NewTaskForm } from "@/components/new-task-form";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { resolveProviderAuth } from "@/server/config/env";
import { providerFor } from "@/server/git/providers";
import { capacity } from "@/server/pipeline/orchestrator";
import { getTask, listDependencies, listDependencyOptions, listRepos } from "@/server/tasks/service";
import { resolveQuotaStatus, spendToday } from "@/server/usage/quota";

export const dynamic = "force-dynamic";

/**
 * `?from=<taskId>` is set by "Duplicate" (`stories.md` S4). Prefills the form
 * from the source task — repo, title (prefixed), description, priority,
 * `requireHumanCodeReview` and `dependsOn` — but deliberately not its
 * attachments: those are copied server-side on submit (`duplicateFrom` on
 * `createTaskSchema`), not re-uploaded through the picker, and rendering them
 * as `existingAttachments` here would let the (nonexistent, in create mode)
 * remove button call `DELETE /api/tasks/undefined/attachments/...`.
 */
export default async function NewTaskPage(props: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await props.searchParams;

  const repos = listRepos().map((repo) => ({
    id: repo.id,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    // Resolved server-side and passed as a prop: the form is a client
    // component and must not import the provider registry itself — see
    // `spec-execution-honesty.md` §7.4.
    changeRequestNoun: providerFor(repo.provider).changeRequestNoun,
  }));

  if (repos.length === 0) {
    return (
      <EmptyState
        title="No repository connected"
        description="Tasks are always scoped to a repository — the agents read its code and deliver a change request against it."
        action={
          <Link href="/repos">
            <Button>Add a repository</Button>
          </Link>
        }
      />
    );
  }

  let source: ReturnType<typeof getTask> = null;
  if (from) {
    source = getTask(from);
    if (!source) notFound();
  }

  // Every repository's candidates: the form narrows them to whichever repo is
  // selected, so changing "Repository" does not need a round trip.
  const dependencyOptions = listDependencyOptions();

  return (
    <NewTaskForm
      repos={repos}
      capacity={capacity()}
      dependencyOptions={dependencyOptions}
      duplicateFrom={source?.id}
      spend={{
        spendToday: spendToday(),
        authMode: resolveProviderAuth().mode,
        quotas: resolveQuotaStatus(),
      }}
      initial={
        source
          ? {
              repoId: source.repoId,
              title: `Copy of ${source.title}`,
              description: source.description,
              priority: source.priority,
              requireHumanCodeReview: source.requireHumanCodeReview,
              dependsOn: listDependencies(source.id).map((dependency) => dependency.id),
            }
          : undefined
      }
    />
  );
}
