import {
  type AccessCheck,
  type ChangeRequestInput,
  type ChangeRequestRef,
  type GitTransport,
  type ProviderContext,
  type RepoIdentity,
  type RepositoryProvider,
  normalizeRepoUrl,
  urlTransport,
} from "./types";

/**
 * The escape hatch for git servers the pipeline knows nothing about — a
 * self-hosted Gitea, a cgit mirror, an internal server behind a proxy.
 *
 * Plain git is all that is assumed: clone, branch, commit and push work over
 * HTTPS Basic exactly as they do everywhere else. Everything layered above git
 * is absent, so there is no API to verify access against and no way to open a
 * change request; the branch is pushed and a human takes it from there.
 */

/**
 * Fallback variable only. A generic connection is required to name its own
 * (`createRepoSchema` enforces it), because there is no convention to rely on.
 */
const CREDENTIAL_ENV_VAR = "GIT_TOKEN";

/** `git@host:team/project.git` — no scheme, so `URL` cannot see it. */
const SCP_LIKE = /^[^/@]+@([^:/]+):(.+)$/;

/** Percent-decodes a path segment, leaving it as-is when it is not valid escaping. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function identityFromPath(host: string, rawPath: string): RepoIdentity | null {
  if (host === "") return null;

  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    // `url.pathname` is percent-encoded while the SCP form is not; decoding
    // here keeps the same repository from producing two different slugs
    // depending on which URL form it was registered with.
    .map(safeDecode)
    .join("/");
  if (path === "") return null;

  // `owner/repo` is a convention, not a rule: a bare `project` and arbitrarily
  // nested paths are both legal here, so only the slug is dependable.
  const segments = path.split("/");
  const tail = segments.length >= 2 ? segments.slice(-2) : [];
  return { slug: path, host, owner: tail[0], repo: tail[1] };
}

export const genericProvider: RepositoryProvider = {
  id: "generic",
  displayName: "Generic git server",
  changeRequestNoun: "pull request",
  // Conventional and harmless: most servers ignore the Basic username and read
  // only the token, but an empty one is rejected outright by those that insist
  // on a non-empty user.
  defaultCredentialUsername: "git",
  defaultCredentialEnvVar: CREDENTIAL_ENV_VAR,
  exampleUrl: "https://git.example.com/team/project.git",

  // Never auto-detected. This provider would match every URL and claim GitHub,
  // GitLab, Bitbucket and Azure DevOps repositories before their own providers
  // got a chance, silently downgrading them to a server with no API. It is
  // selected explicitly or not at all.
  matches() {
    return false;
  },

  parse(repoUrl) {
    const trimmed = repoUrl.trim();

    const scp = SCP_LIKE.exec(trimmed);
    if (scp) return identityFromPath(scp[1], scp[2]);

    try {
      const url = new URL(trimmed);
      /**
       * Scheme allowlist, not just "URL parses".
       *
       * This provider accepts hosts nobody validated, and the URL is handed to
       * `git clone` almost verbatim. `new URL()` happily accepts `ext::sh -c
       * '…'` and `file:///…` — the first is git's remote-helper syntax and runs
       * a shell at clone time. The API schema rejects those too; this is the
       * layer that must hold if the URL ever arrives from anywhere else.
       */
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return identityFromPath(url.host, url.pathname);
    } catch {
      return null;
    }
  },

  transport(repoUrl, credential): GitTransport {
    return urlTransport(repoUrl, credential);
  },

  async verifyAccess(context: ProviderContext): Promise<AccessCheck> {
    // There is no endpoint to probe, so the only thing worth reporting is
    // whether a secret exists at all. Anything more would be a guess dressed up
    // as a check.
    if (!context.credential) {
      // Deliberately does not name a variable: a generic connection always
      // supplies its own `credentialRef`, and `ProviderContext` does not carry
      // it, so naming the conventional one would point at the wrong variable.
      return {
        ok: false,
        reason:
          "No credential is configured for this repository. Set the environment " +
          "variable it points at, or change it in Settings → Repositories.",
      };
    }

    // Deliberately no `defaultBranch`: a generic server exposes nothing to read
    // it from, and the first clone resolves it anyway.
    return { ok: true };
  },

  async createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestRef> {
    throw new Error(
      `A generic git server has no change-request API. Branch ${input.headBranch} has been ` +
        `pushed to ${input.identity.slug}; open the pull request against ${input.baseBranch} ` +
        `by hand on the server's own interface.`,
    );
  },

  manualCreateUrl(repoUrl) {
    // No create-branch-comparison route is known for an unknown server, so the
    // repository itself is the closest useful landing page.
    return normalizeRepoUrl(repoUrl);
  },
};
