// The status-code phrasing is shared, not GitHub-specific.
import { describe } from "./github";
import { basicAuthHeader, providerFetch } from "./http";
import {
  type AccessCheck,
  type ChangeRequestInput,
  type ChangeRequestRef,
  type GitCredential,
  type GitTransport,
  type ProviderContext,
  type RepositoryProvider,
  urlTransport,
  webUrl,
} from "./types";

/**
 * Bitbucket Cloud, via REST API 2.0.
 *
 * Three things differ from the GitHub reference. The Basic-auth username is
 * fixed to `x-token-auth` for access tokens, the repository is addressed by
 * workspace rather than by owning account, and a pull request takes its
 * branches as nested objects instead of plain strings.
 *
 * Legacy app passwords are the exception to the fixed username: they
 * authenticate as an Atlassian account and need that account's real username,
 * which is what the per-connection credential username override exists for.
 */

const DEFAULT_API = "https://api.bitbucket.org/2.0";

function apiBase(context: { apiBaseUrl: string | null }): string {
  return (context.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/, "");
}

function authHeaders(credential: GitCredential | null): Record<string, string> {
  return credential
    ? { Authorization: basicAuthHeader(credential.username, credential.secret) }
    : {};
}

export const bitbucketProvider: RepositoryProvider = {
  id: "bitbucket",
  displayName: "Bitbucket",
  changeRequestNoun: "pull request",
  // Mandatory, and the most tempting thing in this file to "tidy up": Bitbucket
  // resolves a repository, project or workspace access token only when the
  // Basic-auth username is exactly `x-token-auth`. Any other value — GitHub's
  // `x-access-token` included — is read as an account name and rejected.
  defaultCredentialUsername: "x-token-auth",
  defaultCredentialEnvVar: "BITBUCKET_TOKEN",
  exampleUrl: "https://bitbucket.org/acme/storefront",

  matches(repoUrl) {
    return /(^|\/\/|@)bitbucket\.org[/:]/.test(repoUrl);
  },

  parse(repoUrl) {
    // Bitbucket hands out clone URLs as `https://user@bitbucket.org/...`, so the
    // match is anchored on the host; the embedded username sits before it and
    // never reaches the path captures. `urlTransport` replaces it at clone time.
    const match = /bitbucket\.org[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
    if (!match) return null;

    const [, workspace, repo] = match;
    return { slug: `${workspace}/${repo}`, host: "bitbucket.org", owner: workspace, repo };
  },

  transport(repoUrl, credential): GitTransport {
    return urlTransport(repoUrl, credential);
  },

  async verifyAccess(context: ProviderContext): Promise<AccessCheck> {
    const { owner: workspace, repo } = context.identity;
    if (!workspace || !repo) {
      return { ok: false, reason: "Could not read workspace/repo from the URL." };
    }
    if (!context.credential) return { ok: false, reason: "No credential is configured." };

    try {
      // Unlike GitHub, the repository object carries no write flag, so a
      // read-only token passes this check and only fails at delivery.
      const data = await providerFetch<{ mainbranch?: { name?: string } }>({
        url: `${apiBase(context)}/repositories/${workspace}/${repo}`,
        headers: authHeaders(context.credential),
      });
      // A repository with no commits yet has no main branch; that is still a
      // usable connection, so the branch is left for the caller to default.
      return { ok: true, defaultBranch: data.mainbranch?.name };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  },

  async createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestRef> {
    const { owner: workspace, repo } = input.identity;
    const data = await providerFetch<{ id: number; links: { html: { href: string } } }>({
      url: `${apiBase(input)}/repositories/${workspace}/${repo}/pullrequests`,
      method: "POST",
      headers: authHeaders(input.credential),
      body: {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.headBranch } },
        destination: { branch: { name: input.baseBranch } },
      },
    });
    return { url: data.links.html.href, id: data.id };
  },

  manualCreateUrl(repoUrl, baseBranch, headBranch) {
    // `webUrl`, not `normalizeRepoUrl`: a Bitbucket clone URL carries the
    // account name as a Basic-auth username, and this link goes in front of a
    // person.
    const base = webUrl(repoUrl);
    return `${base}/pull-requests/new?source=${encodeURIComponent(
      headBranch,
    )}&dest=${encodeURIComponent(baseBranch)}`;
  },
};
