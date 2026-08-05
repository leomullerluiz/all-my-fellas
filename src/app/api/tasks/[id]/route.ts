import {
  badRequest,
  conflict,
  isMultipartRequest,
  json,
  notFound,
  parseBody,
  parseMultipartFields,
  serverError,
} from "@/server/http/respond";
import {
  GateError,
  TaskNotFoundError,
  deleteCreatedTask,
  editTask,
} from "@/server/pipeline/orchestrator";
import {
  getRepo,
  getTask,
  getTaskWithRepo,
  listApprovals,
  listAttachments,
  listDependencies,
  listLatestArtifacts,
  listStageRuns,
  totalCostForTask,
  wouldCreateCycle,
} from "@/server/tasks/service";
import { validateAttachmentFiles } from "@/server/validation/attachments";
import { type UpdateTaskInput, updateTaskSchema } from "@/server/validation/schemas";

/** `GET /api/tasks/:id` — full detail: stage, artifacts, runs, cost, PR. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const task = getTaskWithRepo(id);
    if (!task) return notFound(`Task ${id} not found.`);

    return json({
      task,
      stageRuns: listStageRuns(id),
      artifacts: listLatestArtifacts(id),
      approvals: listApprovals(id),
      attachments: listAttachments(id).map((attachment) => ({
        ...attachment,
        url: `/api/tasks/${id}/attachments/${attachment.id}`,
      })),
      costUsd: totalCostForTask(id),
      dependsOn: listDependencies(id),
    });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * `PATCH /api/tasks/:id` — edits a task that has not started.
 *
 * The stage is re-read server-side: a disabled control on a stale board is a
 * hint, not a guarantee. Plain JSON when no files are attached, exactly like
 * `POST /api/tasks`.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    let fields: UpdateTaskInput;
    let files: File[] = [];

    if (isMultipartRequest(request)) {
      const parsed = await parseMultipartFields(request, updateTaskSchema);
      if (!parsed.ok) return parsed.response;
      fields = parsed.data;
      files = parsed.formData
        .getAll("attachments")
        .filter((entry): entry is File => entry instanceof File);
    } else {
      const parsed = await parseBody(request, updateTaskSchema);
      if (!parsed.ok) return parsed.response;
      fields = parsed.data;
    }

    if (!getRepo(fields.repoId)) {
      return badRequest("That repository connection no longer exists.");
    }

    if (fields.dependsOn.includes(id)) {
      return badRequest("A task cannot depend on itself.");
    }
    const unknownDependency = fields.dependsOn.find((dependencyId) => !getTask(dependencyId));
    if (unknownDependency) {
      return badRequest(`Prerequisite task ${unknownDependency} does not exist.`);
    }
    const completedDependency = fields.dependsOn.find(
      (dependencyId) => getTask(dependencyId)?.status === "completed",
    );
    if (completedDependency) {
      const dependency = getTask(completedDependency)!;
      return badRequest(`"${dependency.title}" is already completed and cannot be a prerequisite.`);
    }
    // Identify which selected id closes the loop, so the 400 names the cycle
    // rather than just reporting that one exists somewhere in the set.
    const cycleCause = fields.dependsOn.find((dependencyId) => wouldCreateCycle(id, [dependencyId]));
    if (cycleCause) {
      const task = getTask(id)!;
      const dependency = getTask(cycleCause)!;
      return badRequest(
        `"${dependency.title}" already depends on "${task.title}" (directly or transitively) — ` +
          `making it a prerequisite here would create a circular chain.`,
      );
    }

    const validatedAttachments = await validateAttachmentFiles(files);
    if (!validatedAttachments.ok) return validatedAttachments.response;

    editTask(id, fields, validatedAttachments.data);
    return json({ task: getTask(id) });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}

/** `DELETE /api/tasks/:id` — removes a task that has not started. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    deleteCreatedTask(id);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
