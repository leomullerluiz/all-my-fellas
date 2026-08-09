import { requireCredential, resolveCredential } from "./credentials";
import { providerFor } from "./providers";
import type { AccessCheck, ProviderContext, RepositoryProvider } from "./providers/types";
import { redactRemote } from "./workspace";

/**
 * Change request creation, dispatched to the connection's provider.
 *
 * The previous implementation shelled out to `gh`. Calling REST directly drops
 * an external binary from the install requirements, avoids needing one CLI per
 * provider, and keeps the credential out of a subprocess environment.
 */

export type ChangeRequestResult =
  | { status: "created"; url: string; noun: string; number: number | null }
  | { status: "manual"; url: string; reason: string; noun: string };

/** A repository connection, as the git layer needs to see it. */
export type RepoConnection = {
  provider: string;
  url: string;
  defaultBranch: string;
  credentialRef: string | null;
  credentialUsername: string | null;
  apiBaseUrl: string | null;
};

export class UnparsableRepoUrlError extends Error {
  constructor(provider: RepositoryProvider, url: string) {
    super(`${provider.displayName} does not recognise the URL "${url}".`);
    this.name = "UnparsableRepoUrlError";
  }
}

/** Resolves a stored connection into everything the provider layer needs. */
export function connectionContext(connection: RepoConnection): ProviderContext & {
  provider: RepositoryProvider;
} {
  const provider = providerFor(connection.provider);
  const identity = provider.parse(connection.url);
  if (!identity) throw new UnparsableRepoUrlError(provider, connection.url);

  return {
    provider,
    repoUrl: connection.url,
    identity,
    apiBaseUrl: connection.apiBaseUrl,
    credential: resolveCredential({
      provider,
      credentialRef: connection.credentialRef,
      credentialUsername: connection.credentialUsername,
    }),
  };
}

/** Same, but fails loudly when no credential is configured. */
export function requireConnectionContext(connection: RepoConnection): ProviderContext & {
  provider: RepositoryProvider;
} {
  const context = connectionContext(connection);
  return {
    ...context,
    credential: requireCredential({
      provider: context.provider,
      credentialRef: connection.credentialRef,
      credentialUsername: connection.credentialUsername,
    }),
  };
}

/**
 * Opens the change request, falling back to a link the user can follow.
 *
 * Delivery must not fail because an API call did: the branch is already pushed,
 * and a manual link keeps the work reachable.
 */
export async function createChangeRequest(options: {
  connection: RepoConnection;
  headBranch: string;
  title: string;
  body: string;
}): Promise<ChangeRequestResult> {
  const { connection, headBranch, title, body } = options;
  const context = connectionContext(connection);
  const { provider } = context;
  const fallback = provider.manualCreateUrl(
    connection.url,
    connection.defaultBranch,
    headBranch,
  );

  if (!context.credential) {
    return {
      status: "manual",
      url: fallback,
      noun: provider.changeRequestNoun,
      reason: "No credential is configured for this repository.",
    };
  }

  try {
    const created = await provider.createChangeRequest({
      ...context,
      baseBranch: connection.defaultBranch,
      headBranch,
      title,
      body,
    });
    // `ChangeRequestRef.id` is typed `string | number` because a future
    // provider might not hand back a number, but every provider implemented
    // today does; a non-numeric id is stored as `null` rather than guessed at.
    const number =
      typeof created.id === "number"
        ? created.id
        : Number.isFinite(Number(created.id))
          ? Number(created.id)
          : null;
    return { status: "created", url: created.url, noun: provider.changeRequestNoun, number };
  } catch (error) {
    return {
      status: "manual",
      url: fallback,
      noun: provider.changeRequestNoun,
      reason: redactRemote(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Verifies a repository is reachable, used when registering a connection. */
export async function verifyRepositoryAccess(
  connection: RepoConnection,
): Promise<AccessCheck> {
  let context;
  try {
    context = connectionContext(connection);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (!context.credential) {
    return { ok: false, reason: "No credential is configured for this repository." };
  }

  try {
    return await context.provider.verifyAccess(context);
  } catch (error) {
    // A provider that throws here would take the connection form down with it.
    return { ok: false, reason: redactRemote(error instanceof Error ? error.message : String(error)) };
  }
}
