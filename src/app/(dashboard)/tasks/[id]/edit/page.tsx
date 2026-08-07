import { notFound, redirect } from "next/navigation";

import { NewTaskForm } from "@/components/new-task-form";
import {
  getTask,
  listAttachments,
  listDependencies,
  listDependencyOptions,
  listRepos,
} from "@/server/tasks/service";

export const dynamic = "force-dynamic";

/**
 * Edit screen for a task that has not started.
 *
 * A task past `CREATED` is redirected to its detail page rather than shown a
 * form it cannot submit — the API would refuse the PATCH anyway.
 */
export default async function EditTaskPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  const task = getTask(id);
  if (!task) notFound();
  if (task.currentStage !== "CREATED") redirect(`/tasks/${id}`);

  const repos = listRepos().map((repo) => ({
    id: repo.id,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
  }));

  // Excludes the task itself and any task that can no longer be a prerequisite;
  // see `listDependencyOptions`. Candidates from every repository are passed
  // through — the form shows only the selected repo's, and the repo is itself
  // editable here.
  const dependencyOptions = listDependencyOptions(task.id);

  return (
    <NewTaskForm
      repos={repos}
      mode="edit"
      taskId={task.id}
      initial={{
        repoId: task.repoId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        requireHumanCodeReview: task.requireHumanCodeReview,
        attachments: listAttachments(task.id),
        dependsOn: listDependencies(task.id).map((dependency) => dependency.id),
      }}
      dependencyOptions={dependencyOptions}
    />
  );
}
