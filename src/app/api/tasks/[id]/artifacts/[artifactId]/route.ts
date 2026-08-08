import { json, notFound, serverError } from "@/server/http/respond";
import { getArtifact } from "@/server/tasks/service";

type Params = { id: string; artifactId: string };

/**
 * `GET /api/tasks/:id/artifacts/:artifactId` — one artifact's full body.
 *
 * `listArtifactVersions` (§7) never loads `content_md`, so the version
 * switcher fetches an older body from here on demand rather than shipping
 * every version's Markdown into the server-rendered payload.
 *
 * Scoped to `id`, the same shape `deleteAttachment`/the attachment download
 * route use: an artifact id belonging to another task is a 404, not a 403.
 */
export async function GET(_request: Request, context: { params: Promise<Params> }) {
  try {
    const { id, artifactId } = await context.params;
    const artifact = getArtifact(id, artifactId);
    if (!artifact) return notFound(`Artifact ${artifactId} not found.`);

    return json({
      id: artifact.id,
      type: artifact.type,
      stageRunId: artifact.stageRunId,
      contentMd: artifact.contentMd,
      createdAt: artifact.createdAt,
    });
  } catch (error) {
    return serverError(error);
  }
}
