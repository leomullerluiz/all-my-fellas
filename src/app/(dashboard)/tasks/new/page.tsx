import Link from "next/link";

import { NewTaskForm } from "@/components/new-task-form";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { capacity } from "@/server/pipeline/orchestrator";
import { listRepos, listTasks } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

export default async function NewTaskPage() {
  const repos = listRepos().map((repo) => ({
    id: repo.id,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
  }));

  if (repos.length === 0) {
    return (
      <EmptyState
        title="No repository connected"
        description="Tasks are always scoped to a repository — the agents read its code and deliver a pull request against it."
        action={
          <Link href="/repos">
            <Button>Add a repository</Button>
          </Link>
        }
      />
    );
  }

  const dependencyOptions = listTasks().map((task) => ({
    id: task.id,
    title: task.title,
    repoName: task.repo.name,
  }));

  return <NewTaskForm repos={repos} capacity={capacity()} dependencyOptions={dependencyOptions} />;
}
