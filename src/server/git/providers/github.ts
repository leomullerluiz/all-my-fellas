import { ProviderApiError, providerFetch } from "./http";
import {
  type AccessCheck,
  type ChangeRequestInput,
  type ChangeRequestRef,
  type GitCredential,
  type GitTransport,
  type ProviderContext,
  type RepositoryProvider,
  normalizeRepoUrl,
  urlTransport,
} from "./types";

/**
 * GitHub, via the REST API.
 *
 * This is the reference implementation: the other providers differ only in the
 * Basic-auth username, the URL shape, and the endpoints.
 */

const DEFAULT_API = "https://api.github.com";

function apiBase(context: { apiBaseUrl: string | null }): string {
  return (context.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/, "");
}

function authHeaders(credential: GitCredential | null): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(credential ? { Authorization: `Bearer ${credential.secret}` } : {}),
  };
}

export const githubProvider: RepositoryProvider = {
  id: "github",
  displayName: "GitHub",
  changeRequestNoun: "pull request",
  // Ignored by GitHub for PATs, but it is the documented value for installation
  // tokens and has been this pipeline's behaviour since the first release.
  defaultCredentialUsername: "x-access-token",
  defaultCredentialEnvVar: "GITHUB_TOKEN",
  exampleUrl: "https://github.com/acme/storefront",

  matches(repoUrl) {
    return /(^|\/\/|@)github\.com[/:]/.test(repoUrl);
  },

  parse(repoUrl) {
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
    if (!match) return null;

    const [, owner, repo] = match;
    return { slug: `${owner}/${repo}`, host: "github.com", owner, repo };
  },

  transport(repoUrl, credential): GitTransport {
    return urlTransport(repoUrl, credential);
  },

  async verifyAccess(context: ProviderContext): Promise<AccessCheck> {
    const { owner, repo } = context.identity;
    if (!owner || !repo) return { ok: false, reason: "Could not read owner/repo from the URL." };
    if (!context.credential) return { ok: false, reason: "No credential is configured." };

    try {
      const data = await providerFetch<{ default_branch?: string; permissions?: { push?: boolean } }>(
        {
          url: `${apiBase(context)}/repos/${owner}/${repo}`,
          headers: authHeaders(context.credential),
        },
      );
      // A read-only token clones fine but cannot deliver, and finding that out
      // at the last stage after a full pipeline run is the expensive way.
      if (data.permissions && data.permissions.push === false) {
        return {
          ok: false,
          reason: "The token can read this repository but cannot push to it.",
        };
      }
      return { ok: true, defaultBranch: data.default_branch };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  },

  async createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestRef> {
    const { owner, repo } = input.identity;
    const data = await providerFetch<{ html_url: string; number: number }>({
      url: `${apiBase(input)}/repos/${owner}/${repo}/pulls`,
      method: "POST",
      headers: authHeaders(input.credential),
      body: {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      },
    });
    return { url: data.html_url, id: data.number };
  },

  manualCreateUrl(repoUrl, baseBranch, headBranch) {
    const base = normalizeRepoUrl(repoUrl);
    return `${base}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(
      headBranch,
    )}?expand=1`;
  },
};

/** Turns an API failure into something worth showing a user. */
export function describe(error: unknown): string {
  if (error instanceof ProviderApiError) {
    if (error.status === 401) return "The credential was rejected (401).";
    if (error.status === 403) return `Access forbidden (403): ${error.message}`;
    if (error.status === 404) {
      return "Repository not found (404) — check the URL, and that the token can see it.";
    }
    if (error.status === 0) return `Could not reach the provider: ${error.message}`;
    return `${error.message} (HTTP ${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}
