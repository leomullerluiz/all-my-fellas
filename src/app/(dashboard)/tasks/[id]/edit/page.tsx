import { notFound, redirect } from "next/navigation";

import { NewTaskForm } from "@/components/new-task-form";
import { getTask, listAttachments, listDependencies, listRepos, listTasks } from "@/server/tasks/service";

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

  // A task cannot depend on itself, so it is excluded from its own options.
  const dependencyOptions = listTasks()
    .filter((other) => other.id !== task.id)
    .map((other) => ({ id: other.id, title: other.title, repoName: other.repo.name }));

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
