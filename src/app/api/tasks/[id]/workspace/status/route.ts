import { json, notFound, serverError } from "@/server/http/respond";
import { workspaceIsDirty } from "@/server/git/workspace";
import { getTask } from "@/server/tasks/service";

/**
 * `GET /api/tasks/:id/workspace/status` — whether the task's workspace has
 * uncommitted changes, for the dirty-tree warning at `HUMAN_CODE_REVIEW`.
 *
 * `available: false` covers both "no workspace path recorded yet" and "the
 * directory is gone" — `workspaceIsDirty` returns `null` for the latter, and
 * both are the same "nothing to warn about" case to the caller.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    const task = getTask(id);
    if (!task) return notFound(`Task ${id} not found.`);
    if (!task.workspacePath) {
      return json({ available: false, dirty: false });
    }

    const dirty = await workspaceIsDirty(task.workspacePath);
    if (dirty === null) {
      return json({ available: false, dirty: false });
    }
    return json({ available: true, dirty });
  } catch (error) {
    return serverError(error);
  }
}
