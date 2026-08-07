import { badRequest, json, notFound, serverError } from "@/server/http/respond";
import { readDiffIndex, readFilePatch } from "@/server/git/diff";
import { parseDiffSummaryArtifact } from "@/server/pipeline/diff-summary";
import { getTaskWithRepo, latestArtifact } from "@/server/tasks/service";

/**
 * `GET /api/tasks/:id/diff` — the changed-file index.
 * `GET /api/tasks/:id/diff?file=<path>` — the unified diff for one file.
 *
 * Reading the workspace from the web process is fine here: it is a local,
 * read-only git command on the filesystem both processes already share, and it
 * cannot interfere with a running stage.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    const task = getTaskWithRepo(id);
    if (!task) return notFound(`Task ${id} not found.`);
    if (!task.workspacePath) {
      // The workspace is gone (retention cleanup, or the task never reached a
      // stage that needs one). The persisted `diff_summary` artifact (§8) is
      // the durable substitute — a per-file status table, no patch bodies.
      const summaryArtifact = latestArtifact(id, "diff_summary");
      const summary = summaryArtifact ? parseDiffSummaryArtifact(summaryArtifact.contentMd) : null;

      return json(
        {
          available: false,
          reason:
            "This task has no workspace on disk. It either has not reached the Developer " +
            "stage yet, or the workspace was removed after the retention window.",
          prUrl: task.prUrl,
          summary,
        },
        { status: 200 },
      );
    }

    const index = await readDiffIndex(task.workspacePath, task.repo.defaultBranch);

    const requested = new URL(request.url).searchParams.get("file");
    if (requested === null) {
      return json({ available: true, ...index });
    }

    // The path must be one git itself reported for this task. Validating against
    // a computed set rather than parsing the string is airtight: it rules out
    // traversal, absolute paths, another task's workspace, and a leading "-"
    // that git would read as an option.
    const file = index.files.find((candidate) => candidate.path === requested);
    if (!file) {
      return badRequest("That file is not part of this task's diff.");
    }

    const patch = await readFilePatch(task.workspacePath, task.repo.defaultBranch, file);
    return json({ available: true, ...patch });
  } catch (error) {
    return serverError(error);
  }
}
