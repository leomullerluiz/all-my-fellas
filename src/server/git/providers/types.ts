/**
 * The repository provider contract.
 *
 * Everything provider-specific lives behind this interface: URL parsing, how a
 * credential is attached to a git command, the access check, and how a change
 * request is opened. `workspace.ts` and `execute.ts` know none of it.
 *
 * The credential mechanism itself is provider-independent — it is plain HTTP
 * Basic over git-over-HTTPS, which every provider supports. What varies is the
 * username, and everything layered above git.
 */

export const PROVIDER_IDS = [
  "github",
  "gitlab",
  "bitbucket",
  "azure_devops",
  "generic",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type GitCredential = {
  /** Username for HTTP Basic. An empty string means "omit it". */
  username: string;
  secret: string;
};

/**
 * How a credential is attached to one git invocation.
 *
 * `url` embeds it in the remote; `header` passes it via `-c http.extraHeader`,
 * which is what Azure DevOps documents and which keeps the secret out of any
 * string git might echo into an error message.
 */
export type GitTransport =
  | { kind: "url"; url: string; configArgs: readonly string[] }
  | { kind: "header"; url: string; configArgs: readonly string[] };

/**
 * Denies git every interactive credential source, on every invocation.
 *
 * The server authenticates from `credentialRef` alone. Anything else is a hang
 * waiting to happen: a repository that is private, deleted or misspelled is
 * indistinguishable from one needing a login, so git falls back to asking —
 * and no one is there to answer. The request never fails, it just stops.
 *
 * Clearing the helper list is the part that matters. `GIT_TERMINAL_PROMPT=0`
 * only suppresses git's own tty prompt; a helper like Git Credential Manager
 * opens its own dialog and blocks regardless of it. An empty value resets the
 * list rather than adding to it, which is why it is spelled with no argument.
 *
 * Applied by the transport, so it reaches every network call that already
 * spreads `configArgs`, rather than each call site remembering it.
 */
const NON_INTERACTIVE: readonly string[] = ["-c", "credential.helper="];

/**
 * What a provider's API needs to identify a repository.
 *
 * `owner/repo` is not universal: GitLab needs a URL-encoded full path with
 * arbitrary subgroup nesting, and Azure DevOps needs organization, project and
 * repository. Each provider fills in the fields it uses.
 */
export type RepoIdentity = {
  /** Display form, e.g. `owner/repo` or `org/project/repo`. */
  slug: string;
  host: string;
  owner?: string;
  repo?: string;
  /** GitLab: the full namespace path, subgroups included. */
  projectPath?: string;
  /** Azure DevOps. */
  organization?: string;
  project?: string;
};

export type ProviderContext = {
  repoUrl: string;
  identity: RepoIdentity;
  credential: GitCredential | null;
  /** Override for self-hosted instances; `null` uses the provider's default. */
  apiBaseUrl: string | null;
};

export type AccessCheck =
  | { ok: true; defaultBranch?: string }
  | { ok: false; reason: string };

export type ChangeRequestInput = ProviderContext & {
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
};

export type ChangeRequestRef = { url: string; id: string | number };

export interface RepositoryProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** "pull request" or "merge request" — used verbatim in the UI. */
  readonly changeRequestNoun: string;
  /**
   * Basic-auth username this provider expects. Bitbucket requires
   * `x-token-auth`; Azure DevOps ignores it entirely; GitLab accepts anything
   * non-empty. Overridable per connection for account-name credentials.
   */
  readonly defaultCredentialUsername: string;
  /** Conventional environment variable when a connection names none. */
  readonly defaultCredentialEnvVar: string;
  /** Placeholder shown in the connection form. */
  readonly exampleUrl: string;

  /** Whether this provider recognises the URL, for auto-detection. */
  matches(repoUrl: string): boolean;

  /** Parses the URL, or returns `null` when it is not one this provider owns. */
  parse(repoUrl: string): RepoIdentity | null;

  /** Builds the authenticated transport for a single git command. */
  transport(repoUrl: string, credential: GitCredential | null): GitTransport;

  /** Cheap reachability and permission check, run when a connection is saved. */
  verifyAccess(context: ProviderContext): Promise<AccessCheck>;

  /**
   * Opens the change request.
   *
   * @throws when the API rejects it; the caller falls back to
   *   {@link manualCreateUrl} so the branch is still usable.
   */
  createChangeRequest(input: ChangeRequestInput): Promise<ChangeRequestRef>;

  /** Web URL a human can open to create it by hand. */
  manualCreateUrl(repoUrl: string, baseBranch: string, headBranch: string): string;
}

/** Strips a trailing `.git` and any trailing slash from a repository URL. */
export function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * The normalized URL with any embedded userinfo removed, for links shown to a
 * person.
 *
 * Bitbucket and Azure DevOps both hand out clone URLs carrying a Basic-auth
 * username (`https://acme@bitbucket.org/...`). That belongs in a git remote,
 * not in a browser link: it discloses an account name and some browsers warn
 * on userinfo URLs. Only the username is ever present in a stored clone URL,
 * but the password is cleared too so this stays safe if one ever is.
 */
export function webUrl(repoUrl: string): string {
  const base = normalizeRepoUrl(repoUrl);
  try {
    const url = new URL(base);
    if (url.username === "" && url.password === "") return base;
    url.username = "";
    url.password = "";
    // `toString()` re-adds the trailing slash it normalizes an empty path to.
    return url.toString().replace(/\/+$/, "");
  } catch {
    return base;
  }
}

/**
 * Embeds a credential in the remote URL.
 *
 * Shared by every provider except Azure DevOps. Assigning `username`/`password`
 * on a `URL` percent-encodes them, which is what makes tokens containing `@`,
 * `:` or `/` safe here. Existing usernames in a clone URL — Bitbucket and Azure
 * DevOps both emit them — are replaced rather than appended.
 */
export function urlTransport(
  repoUrl: string,
  credential: GitCredential | null,
): GitTransport {
  if (!credential) return { kind: "url", url: repoUrl, configArgs: [...NON_INTERACTIVE] };

  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:")
      return { kind: "url", url: repoUrl, configArgs: [...NON_INTERACTIVE] };
    url.username = credential.username;
    url.password = credential.secret;
    return { kind: "url", url: url.toString(), configArgs: [...NON_INTERACTIVE] };
  } catch {
    return { kind: "url", url: repoUrl, configArgs: [...NON_INTERACTIVE] };
  }
}

/**
 * Sends the credential as an `Authorization: Basic` header instead.
 *
 * The remote URL stays clean, so the secret never reaches `.git/config` or a
 * git error message.
 */
export function headerTransport(
  repoUrl: string,
  credential: GitCredential | null,
): GitTransport {
  if (!credential) return { kind: "header", url: repoUrl, configArgs: [...NON_INTERACTIVE] };

  const basic = Buffer.from(`${credential.username}:${credential.secret}`).toString("base64");
  return {
    kind: "header",
    url: repoUrl,
    configArgs: [...NON_INTERACTIVE, "-c", `http.extraHeader=Authorization: Basic ${basic}`],
  };
}
