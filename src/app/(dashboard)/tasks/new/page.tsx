import Link from "next/link";

import { NewTaskForm } from "@/components/new-task-form";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { providerFor } from "@/server/git/providers";
import { capacity } from "@/server/pipeline/orchestrator";
import { listDependencyOptions, listRepos } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

export default async function NewTaskPage() {
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

  // Every repository's candidates: the form narrows them to whichever repo is
  // selected, so changing "Repository" does not need a round trip.
  const dependencyOptions = listDependencyOptions();

  return <NewTaskForm repos={repos} capacity={capacity()} dependencyOptions={dependencyOptions} />;
}
