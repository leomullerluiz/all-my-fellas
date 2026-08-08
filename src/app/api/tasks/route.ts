import {
  badRequest,
  isMultipartRequest,
  json,
  parseBody,
  parseMultipartFields,
  serverError,
} from "@/server/http/respond";
import { CapacityError, DependencyError, QuotaError, capacity, startTask } from "@/server/pipeline/orchestrator";
import {
  createTask,
  getRepo,
  getTask,
  listDependencies,
  listTasks,
  totalCostForTask,
} from "@/server/tasks/service";
import { validateAttachmentFiles } from "@/server/validation/attachments";
import { createTaskSchema, listTasksQuerySchema } from "@/server/validation/schemas";
import type { CreateTaskInput } from "@/server/validation/schemas";

/** `GET /api/tasks?status=` — board and list views, plus current capacity. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = listTasksQuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
    });
    if (!parsed.success) return badRequest("Unknown status filter.");

    const tasks = listTasks(parsed.data).map((task) => ({
      ...task,
      costUsd: totalCostForTask(task.id),
      dependsOn: listDependencies(task.id),
    }));
    return json({ tasks, capacity: capacity() });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * `POST /api/tasks` — creates a task at `CREATED`.
 *
 * The pipeline is entered only when `start: true`. A capacity refusal still
 * leaves the task created, so the work is not lost — the user can start it once
 * a slot frees.
 *
 * Plain JSON when no files are attached (the client only builds a
 * `multipart/form-data` body once a file is picked), so the existing
 * JSON-only contract is untouched.
 */
export async function POST(request: Request) {
  try {
    let fields: CreateTaskInput;
    let files: File[] = [];

    if (isMultipartRequest(request)) {
      const parsed = await parseMultipartFields(request, createTaskSchema);
      if (!parsed.ok) return parsed.response;
      fields = parsed.data;
      files = parsed.formData
        .getAll("attachments")
        .filter((entry): entry is File => entry instanceof File);
    } else {
      const parsed = await parseBody(request, createTaskSchema);
      if (!parsed.ok) return parsed.response;
      fields = parsed.data;
    }

    if (!getRepo(fields.repoId)) {
      return badRequest("That repository connection no longer exists.");
    }

    const unknownDependency = fields.dependsOn.find((id) => !getTask(id));
    if (unknownDependency) {
      return badRequest(`Prerequisite task ${unknownDependency} does not exist.`);
    }
    const completedDependency = fields.dependsOn.find((id) => getTask(id)?.status === "completed");
    if (completedDependency) {
      const dependency = getTask(completedDependency)!;
      return badRequest(`"${dependency.title}" is already completed and cannot be a prerequisite.`);
    }

    const validatedAttachments = await validateAttachmentFiles(files);
    if (!validatedAttachments.ok) return validatedAttachments.response;

    const created = createTask({ ...fields, attachments: validatedAttachments.data });
    if (!fields.start) {
      return json({ task: created, started: false }, { status: 201 });
    }

    try {
      startTask(created.id);
      return json({ task: getTask(created.id) ?? created, started: true }, { status: 201 });
    } catch (error) {
      if (error instanceof CapacityError || error instanceof DependencyError || error instanceof QuotaError) {
        // The task is created and safe at `CREATED`; only the optional start
        // was refused. Return 409 with the task so the client can navigate to
        // it instead of losing the input.
        return json(
          { task: created, started: false, error: error.message },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error) {
    return serverError(error);
  }
}
