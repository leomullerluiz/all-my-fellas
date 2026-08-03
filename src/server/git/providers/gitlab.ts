import { describe } from "./github";
import { providerFetch } from "./http";
import {
  type AccessCheck,
  type ChangeRequestInput,
  type ChangeRequestRef,
  type GitCredential,
  type GitTransport,
  type ProviderContext,
  type RepoIdentity,
  type RepositoryProvider,
  normalizeRepoUrl,
  urlTransport,
} from "./types";

/**
 * GitLab, via the REST v4 API.
 *
 * Two things differ from GitHub. Projects nest under arbitrarily many
 * subgroups, so there is no `owner/repo` pair — the identity is the full
 * namespace path, percent-encoded into a single path segment for every API
 * call. And a change request is a *merge request*, which the UI prints
 * verbatim.
 */

const DEFAULT_API = "https://gitlab.com/api/v4";

/** GitLab role levels: 30 is Developer, the lowest that may push a branch. */
const DEVELOPER_ACCESS_LEVEL = 30;

function apiBase(context: { apiBaseUrl: string | null }): string {
  // A self-managed override already points at the API root, so it is used
  // as-is rather than having a version path appended to it.
  return (context.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/, "");
}

function authHeaders(credential: GitCredential | null): Record<string, string> {
  return credential ? { "PRIVATE-TOKEN": credential.secret } : {};
}

/**
 * The value GitLab accepts in place of a numeric project id.
 *
 * The slashes between subgroups have to survive as `%2F`, or the API reads
 * them as path separators and the request lands on a different endpoint.
 */
function projectId(identity: RepoIdentity): string {
  return encodeURIComponent(identity.projectPath ?? identity.slug);
}

export const gitlabProvider: RepositoryProvider = {
  id: "gitlab",
  displayName: "GitLab",
  changeRequestNoun: "merge request",
  // Any non-empty username works over HTTPS; `oauth2` is the documented one.
  defaultCredentialUsername: "oauth2",
  defaultCredentialEnvVar: "GITLAB_TOKEN",
  exampleUrl: "https://gitlab.com/acme/platform/storefront",

  matches(repoUrl) {
    // Only gitlab.com is claimed. A self-managed instance is just a hostname
    // with nothing GitLab-shaped about it, so it cannot be auto-detected —
    // those connections select the provider by hand.
    return /(^|\/\/|@)gitlab\.com[/:]/.test(repoUrl);
  },

  parse(repoUrl) {
    const trimmed = normalizeRepoUrl(repoUrl);

    let host: string;
    let path: string;
    try {
      const url = new URL(trimmed);
      // `host`, not `hostname`: a self-managed instance on a non-default port
      // is exactly the deployment this provider's lenient host handling exists
      // for, and `hostname` silently drops the port.
      host = url.host;
      path = url.pathname;
    } catch {
      // scp-style remotes (`git@host:group/project`) are not valid URLs.
      const scp = /^(?:[^@\s/:]+@)?([^\s/:]+):(.+)$/.exec(trimmed);
      if (!scp) return null;
      host = scp[1];
      path = scp[2];
    }

    /**
     * Reject hosts that belong to a sibling provider.
     *
     * A self-managed GitLab can live on any hostname, so there is no positive
     * test to apply — but claiming a github.com URL is worse than being
     * permissive. Without this, `verifyAccess` would take the path out of a
     * GitHub URL and look it up on gitlab.com; if an unrelated project happens
     * to sit at that path, the connection is reported verified and its default
     * branch is read from somebody else's repository.
     */
    const bare = host.toLowerCase().split(":")[0];
    if (
      bare === "github.com" ||
      bare === "bitbucket.org" ||
      bare === "dev.azure.com" ||
      bare.endsWith(".visualstudio.com")
    ) {
      return null;
    }

    let segments = path.split("/").filter((segment) => segment !== "");
    // GitLab reserves a bare `-` segment to separate the project path from the
    // page beneath it, so a URL copied out of the browser is cut back there.
    const reserved = segments.indexOf("-");
    if (reserved !== -1) segments = segments.slice(0, reserved);

    // A project always sits inside at least one group, so a single segment is
    // not a repository.
    if (host === "" || segments.length < 2) return null;

    const projectPath = segments.join("/");
    return {
      slug: projectPath,
      host,
      // Display convenience only: the API never sees these, because anything
      // between the first and last segment is a subgroup and matters too.
      owner: segments[0],
      repo: segments[segments.length - 1],
      projectPath,
    };
  },

  transport(repoUrl, credential): GitTransport {
    return urlTransport(repoUrl, credential);
  },

  async verifyAccess(context: ProviderContext): Promise<AccessCheck> {
    const project = projectId(context.identity);
    if (project === "") return { ok: false, reason: "Could not read the project path from the URL." };
    if (!context.credential) return { ok: false, reason: "No credential is configured." };

    try {
      const data = await providerFetch<{
        default_branch?: string;
        permissions?: {
          project_access?: { access_level?: number } | null;
          group_access?: { access_level?: number } | null;
        };
      }>({
        url: `${apiBase(context)}/projects/${project}`,
        headers: authHeaders(context.credential),
      });

      /**
       * Reject a token that can only read, for the same reason GitHub's
       * provider does: it clones fine and fails at delivery, after a whole
       * pipeline has been paid for.
       *
       * Level 30 is Developer, the lowest role that can push a branch. Passing
       * this check is necessary but not sufficient — a protected default branch
       * can still refuse the push — so it only rules out the clear-cut case.
       */
      const level = Math.max(
        data.permissions?.project_access?.access_level ?? 0,
        data.permissions?.group_access?.access_level ?? 0,
      );
      if (data.permissions && level > 0 && level < DEVELOPER_ACCESS_LEVEL) {
        return {
          ok: false,
          reason: "The token can read this project but does not have push access.",
        };
      }

      return { ok: true, defaultBranch: data.default_branch };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  },

  async createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestRef> {
    const data = await providerFetch<{ web_url: string; iid: number }>({
      url: `${apiBase(input)}/projects/${projectId(input.identity)}/merge_requests`,
      method: "POST",
      headers: authHeaders(input.credential),
      body: {
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.body,
      },
    });
    // `iid` is the per-project number a human sees; `id` is instance-wide.
    return { url: data.web_url, id: data.iid };
  },

  manualCreateUrl(repoUrl, baseBranch, headBranch) {
    const base = normalizeRepoUrl(repoUrl);
    return (
      `${base}/-/merge_requests/new` +
      `?merge_request[source_branch]=${encodeURIComponent(headBranch)}` +
      `&merge_request[target_branch]=${encodeURIComponent(baseBranch)}`
    );
  },
};
