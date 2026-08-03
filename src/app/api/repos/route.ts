import { badRequest, json, parseBody, serverError } from "@/server/http/respond";
import { credentialSource } from "@/server/git/credentials";
import { detectProvider, providerFor } from "@/server/git/providers";
import { verifyRepositoryAccess } from "@/server/git/pull-request";
import { createRepo, listRepos } from "@/server/tasks/service";
import { createRepoSchema } from "@/server/validation/schemas";

/** `GET /api/repos` — connections, with whether each one's credential resolves. */
export async function GET() {
  try {
    const repos = listRepos().map((repo) => {
      const provider = providerFor(repo.provider);
      return {
        ...repo,
        providerName: provider.displayName,
        changeRequestNoun: provider.changeRequestNoun,
        // The variable name and whether it is set — never the secret.
        credential: credentialSource({
          provider,
          credentialRef: repo.credentialRef,
          credentialUsername: repo.credentialUsername,
        }),
      };
    });
    return json({ repos });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * `POST /api/repos` — registers a connection.
 *
 * Access is verified but not enforced: a repository that is unreachable right
 * now (missing credential, offline) is still stored, with the reason reported
 * so the user can fix it.
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, createRepoSchema);
    if (!parsed.ok) return parsed.response;

    const detected = parsed.data.provider ?? detectProvider(parsed.data.url)?.id;
    if (!detected) {
      return badRequest(
        "Could not tell which provider that URL belongs to. Choose one explicitly — " +
          "use “Generic git server” for a self-hosted or unrecognised host.",
      );
    }

    const connection = {
      provider: detected,
      url: parsed.data.url,
      defaultBranch: parsed.data.defaultBranch,
      credentialRef: parsed.data.credentialRef ?? null,
      credentialUsername: parsed.data.credentialUsername ?? null,
      apiBaseUrl: parsed.data.apiBaseUrl ?? null,
    };

    const access = await verifyRepositoryAccess(connection);
    const repo = createRepo({ name: parsed.data.name, ...connection });

    return json(
      {
        repo,
        verified: access.ok,
        // The provider reports the branch it actually has; a mismatch is the
        // most common reason a first task fails at clone time.
        detectedDefaultBranch: access.ok ? access.defaultBranch : undefined,
        warning: access.ok ? undefined : access.reason,
      },
      { status: 201 },
    );
  } catch (error) {
    return serverError(error);
  }
}
