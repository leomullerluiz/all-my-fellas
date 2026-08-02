import { json, parseBody, serverError } from "@/server/http/respond";
import { verifyRepositoryAccess } from "@/server/git/pull-request";
import { createRepo, listRepos } from "@/server/tasks/service";
import { createRepoSchema } from "@/server/validation/schemas";

/** `GET /api/repos` — registered repository connections. */
export async function GET() {
  try {
    return json({ repos: listRepos() });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * `POST /api/repos` — registers a connection.
 *
 * Access is verified but not enforced: a repository that is unreachable right
 * now (missing token, offline) is still stored, with the reason reported so the
 * user can fix it from Settings.
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, createRepoSchema);
    if (!parsed.ok) return parsed.response;

    const access = await verifyRepositoryAccess(parsed.data.url);
    const repo = createRepo(parsed.data);

    return json(
      { repo, verified: access.ok, warning: access.ok ? undefined : access.reason },
      { status: 201 },
    );
  } catch (error) {
    return serverError(error);
  }
}
