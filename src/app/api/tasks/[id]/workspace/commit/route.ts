import { appendEvent } from "@/server/events/store";
import { commitPendingChanges } from "@/server/git/workspace";
import { badRequest, conflict, json, notFound, serverError } from "@/server/http/respond";
import { getTask } from "@/server/tasks/service";

/**
 * `POST /api/tasks/:id/workspace/commit` — commits whatever the reviewer (or
 * anyone else with a hand in the workspace) left uncommitted while the task
 * sat at `HUMAN_CODE_REVIEW`.
 *
 * Reuses `commitPendingChanges`, the same function `executeAgentStage` calls
 * after `DEVELOPMENT` — no second commit path, no new git identity. Scoped to
 * `HUMAN_CODE_REVIEW` rather than "any task with a workspace": a commit made
 * from the web process at any other stage could race a running job that owns
 * the same working tree.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    const task = getTask(id);
    if (!task) return notFound(`Task ${id} not found.`);
    if (task.currentStage !== "HUMAN_CODE_REVIEW") {
      return conflict(
        `Task is at ${task.currentStage}, not waiting at the code review gate — the workspace is not safe to commit from here.`,
      );
    }
    if (!task.workspacePath) {
      return badRequest("This task has no workspace on disk.");
    }

    const committed = await commitPendingChanges(
      task.workspacePath,
      `fix: manual edit at code review (${task.id})`,
    );
    if (!committed) {
      return json({ committed: false });
    }

    appendEvent(task.id, null, {
      type: "git",
      message: "Committed changes made by hand while the task waited at code review.",
    });

    return json({ committed: true });
  } catch (error) {
    return serverError(error);
  }
}
