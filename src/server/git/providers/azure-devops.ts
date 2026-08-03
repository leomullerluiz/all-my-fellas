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
  headerTransport,
  normalizeRepoUrl,
  webUrl,
} from "./types";

/**
 * Azure DevOps, via the REST API.
 *
 * Four things are specific to this provider: a repository is addressed by an
 * organisation/project/repository triple rather than `owner/repo`, the
 * Basic-auth username is empty, branches reach the pull request API as full
 * refs, and git authenticates over a header instead of the remote URL.
 */

const API_VERSION = "7.1";
const LEGACY_HOST_SUFFIX = ".visualstudio.com";
const HEADS_PREFIX = "refs/heads/";

/**
 * Percent-decodes a path segment, returning it unchanged when the escaping is
 * malformed. `parse` is contracted to return null rather than throw, and a lone
 * `%` survives `new URL()` untouched only to blow up in `decodeURIComponent`.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function apiBase(context: ProviderContext): string {
  const override = context.apiBaseUrl?.replace(/\/+$/, "");
  if (override) return override;

  return `https://dev.azure.com/${encodeURIComponent(context.identity.organization ?? "")}`;
}

/**
 * `{api}/{project}/_apis/git/repositories/{repo}`.
 *
 * Project and repository names may contain spaces and other characters that are
 * illegal in a path, so the decoded names held in the identity are re-encoded
 * on every call.
 */
function repositoryApiUrl(context: ProviderContext): string {
  const project = encodeURIComponent(context.identity.project ?? "");
  const repo = encodeURIComponent(context.identity.repo ?? "");
  return `${apiBase(context)}/${project}/_apis/git/repositories/${repo}`;
}

function authHeaders(credential: GitCredential | null): Record<string, string> {
  if (!credential) return {};

  // Azure DevOps discards the Basic username; Microsoft documents the header as
  // base64(":" + PAT), so the empty username is the documented form, not an
  // oversight.
  return { Authorization: basicAuthHeader("", credential.secret) };
}

function toFullRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `${HEADS_PREFIX}${branch}`;
}

function toBranchName(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

export const azureDevOpsProvider: RepositoryProvider = {
  id: "azure_devops",
  displayName: "Azure DevOps",
  changeRequestNoun: "pull request",
  defaultCredentialUsername: "",
  defaultCredentialEnvVar: "AZURE_DEVOPS_TOKEN",
  exampleUrl: "https://dev.azure.com/acme/Storefront/_git/storefront",

  matches(repoUrl) {
    // Case-insensitive to agree with `parse`, which lowercases the hostname.
    // Without the flag a mixed-case host parsed fine but was never routed here,
    // and the user saw "could not tell which provider that URL belongs to".
    return (
      /(^|\/\/|@)dev\.azure\.com[/:]/i.test(repoUrl) ||
      /(^|\/\/|@)[\w-]+\.visualstudio\.com[/:]/i.test(repoUrl)
    );
  },

  parse(repoUrl) {
    let url: URL;
    try {
      url = new URL(normalizeRepoUrl(repoUrl));
    } catch {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    const onDevAzure = hostname === "dev.azure.com";
    const onLegacyHost = hostname.endsWith(LEGACY_HOST_SUFFIX);
    if (!onDevAzure && !onLegacyHost) return null;

    // Names are stored decoded so the slug reads as a human wrote it; the API
    // helpers percent-encode again. `safeDecode` rather than `decodeURIComponent`
    // because `parse` must never throw — a lone `%` survives `new URL()` intact
    // and would otherwise raise URIError out of a function contracted to return
    // null, escaping all the way to a failed DELIVERY stage.
    const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);

    // `_git` separates the project from the repository, and is never the first
    // segment: dev.azure.com prefixes the organisation, the legacy host the
    // project. Locating it rather than counting segments also tolerates the
    // optional collection segment legacy URLs sometimes carry.
    const separator = segments.indexOf("_git");
    if (separator < 1) return null;

    const repo = segments[separator + 1];
    // Azure DevOps omits the project from the URL when it equals the repository
    // name, which is what its own UI hands you for a single-repo project.
    const project =
      onDevAzure && separator === 1 ? repo : segments[separator - 1];
    // The legacy host names the organisation in its subdomain instead.
    const organization = onDevAzure
      ? segments[0]
      : hostname.slice(0, -LEGACY_HOST_SUFFIX.length);
    if (!organization || !project || !repo) return null;

    return {
      slug: `${organization}/${project}/${repo}`,
      host: url.host,
      organization,
      project,
      repo,
    };
  },

  transport(repoUrl, credential): GitTransport {
    // The one provider that does not use urlTransport. The documented mechanism
    // is an Authorization header, and the URL equivalent would need an empty
    // username — `https://:pat@dev.azure.com/...` — which is both fragile and
    // pointless here, since the clone URL already carries the organisation as a
    // username that would have to be stripped first.
    return headerTransport(repoUrl, credential);
  },

  async verifyAccess(context: ProviderContext): Promise<AccessCheck> {
    const { organization, project, repo } = context.identity;
    if (!organization || !project || !repo) {
      return { ok: false, reason: "Could not read organization/project/repository from the URL." };
    }
    if (!context.credential) return { ok: false, reason: "No credential is configured." };

    try {
      const data = await providerFetch<{ id?: string; defaultBranch?: string }>({
        url: `${repositoryApiUrl(context)}?api-version=${API_VERSION}`,
        headers: authHeaders(context.credential),
      });

      // A rejected PAT does not reliably produce a 401: Azure DevOps answers
      // some unauthenticated requests with a 2xx sign-in page, which is a
      // success as far as providerFetch is concerned. Every repository object
      // carries an id, so its absence means the response is not one.
      if (!data.id) {
        return {
          ok: false,
          reason: "The credential was rejected — Azure DevOps returned a sign-in page, not the repository.",
        };
      }

      // `defaultBranch` arrives as a full ref; the rest of the pipeline works in
      // branch names. It is absent on a repository with no commits yet.
      return {
        ok: true,
        defaultBranch: data.defaultBranch ? toBranchName(data.defaultBranch) : undefined,
      };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  },

  async createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestRef> {
    const data = await providerFetch<{ pullRequestId?: number }>({
      url: `${repositoryApiUrl(input)}/pullrequests?api-version=${API_VERSION}`,
      method: "POST",
      headers: authHeaders(input.credential),
      body: {
        // Bare branch names are rejected: both ends must be full refs.
        sourceRefName: toFullRef(input.headBranch),
        targetRefName: toFullRef(input.baseBranch),
        title: input.title,
        description: input.body,
      },
    });

    /**
     * Azure DevOps answers a rejected PAT with a 2xx sign-in page rather than a
     * 401, so a successful HTTP status is not evidence a pull request exists.
     * Without this check the caller records `…/pullrequest/undefined` as a
     * created change request and the task is reported delivered with a dead
     * link. Throwing routes it to the manual fallback instead. This is reachable
     * without any misconfiguration: PATs expire between the connection check
     * and delivery.
     */
    if (typeof data.pullRequestId !== "number") {
      throw new Error(
        "Azure DevOps accepted the request but returned no pull request id, which " +
          "usually means the token has expired or was rejected.",
      );
    }

    // The response links are API endpoints, so the page a human opens is
    // composed from the repository URL and the returned id.
    return {
      url: `${webUrl(input.repoUrl)}/pullrequest/${data.pullRequestId}`,
      id: data.pullRequestId,
    };
  },

  manualCreateUrl(repoUrl, baseBranch, headBranch) {
    // The create page takes bare branch names, unlike the API above.
    return `${webUrl(repoUrl)}/pullrequestcreate?sourceRef=${encodeURIComponent(
      headBranch,
    )}&targetRef=${encodeURIComponent(baseBranch)}`;
  },
};
