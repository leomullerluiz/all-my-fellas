import { badRequest, conflict, json, notFound, parseBody, serverError } from "@/server/http/respond";
import { credentialSource } from "@/server/git/credentials";
import { providerFor } from "@/server/git/providers";
import { verifyRepositoryAccess } from "@/server/git/pull-request";
import { deleteRepo, getRepo, updateRepoVerificationCommands } from "@/server/tasks/service";
import { updateVerificationCommandsSchema } from "@/server/validation/schemas";

/** `GET /api/repos/:id` — connection detail plus a live access check. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const repo = getRepo(id);
    if (!repo) return notFound(`Repository ${id} not found.`);

    const provider = providerFor(repo.provider);
    const access = await verifyRepositoryAccess(repo);
    return json({
      repo,
      providerName: provider.displayName,
      credential: credentialSource({
        provider,
        credentialRef: repo.credentialRef,
        credentialUsername: repo.credentialUsername,
      }),
      verified: access.ok,
      defaultBranch: access.ok ? access.defaultBranch : undefined,
      reason: access.ok ? undefined : access.reason,
    });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * `PATCH /api/repos/:id` — updates only the verification commands.
 *
 * `updateVerificationCommandsSchema` is `.strict()`, so a body carrying `url`,
 * `credentialRef`, or any other field is a 400 rather than a silent partial
 * update of something this route was never meant to touch.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getRepo(id)) return notFound(`Repository ${id} not found.`);

    const parsed = await parseBody(request, updateVerificationCommandsSchema);
    if (!parsed.ok) return parsed.response;

    if (Object.keys(parsed.data).length === 0) {
      return badRequest("Send at least one verification field to update.");
    }

    const repo = updateRepoVerificationCommands(id, parsed.data);
    return json({ repo });
  } catch (error) {
    return serverError(error);
  }
}

/** `DELETE /api/repos/:id` — refuses while tasks still reference the repo. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getRepo(id)) return notFound(`Repository ${id} not found.`);

    if (!deleteRepo(id)) {
      return conflict("This repository still has tasks and cannot be removed.");
    }
    return json({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
