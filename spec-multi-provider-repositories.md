# Multi-Provider Repository Integration — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Extend All My Fellas beyond GitHub to Bitbucket Cloud, Azure DevOps,
> GitLab and self-hosted git servers.
> **Prerequisite:** the pipeline described in `spec-esteira-multiagente.md`, as built.

---

## 1. Feasibility verdict

**Yes — the credential mechanism generalizes.** The way the pipeline authenticates
today is not a GitHub feature; it is plain HTTP Basic authentication over
git-over-HTTPS, which every major provider supports:

```
https://<username>:<secret>@<host>/<path>
```

`src/server/git/workspace.ts` builds that URL for a single `git clone` or
`git push`, then stores the clean URL back into `.git/config`. The token lives
only in the worker's memory for the duration of one command. **Every security
property of that design is provider-independent** — it survives the change
unmodified.

Two things do *not* generalize, and they are the whole cost of this work:

1. **The username constant.** `x-access-token` is hardcoded. It is correct (or
   at least harmless) for GitHub and GitLab, and **wrong for Bitbucket Cloud**,
   which requires `x-token-auth` for access tokens.
2. **Everything layered above git.** Pull request creation (`gh` CLI), the
   access check (`api.github.com`), the fallback "open a PR" URL shape, and the
   `owner/repo` URL parsing are all GitHub-only.

A third issue is structural rather than protocol-level: **there is one global
`GITHUB_TOKEN`.** Multiple providers require multiple credentials, and the
constraint that secrets never reach the database (spec §6) has to be preserved.

The database already carries a `provider` column on `repos`, defaulted to
`'github'`. The original schema anticipated this, so no destructive migration is
needed.

---

## 2. Current coupling inventory

Every GitHub-specific line in the codebase, so the blast radius is explicit.

| Location | What is coupled | Severity |
|---|---|---|
| `src/server/git/workspace.ts:34` | `url.username = "x-access-token"` | **Blocking** for Bitbucket |
| `src/server/git/workspace.ts:179` | Push refuses without `GITHUB_TOKEN` | Blocking |
| `src/server/config/env.ts:72,77` | `hasGithubToken()` / `readGithubToken()` read one env var | Blocking |
| `src/server/git/pull-request.ts` (whole file) | `gh` CLI, `api.github.com`, GitHub compare URL, `github.com` regex | Blocking |
| `src/server/validation/schemas.ts:40` | Zod `refine` rejects any URL without `github.com` | Blocking |
| `src/server/db/schema.ts:28`, `bootstrap.sql.ts:17` | `provider` typed and defaulted to `"github"` | Minor — column exists |
| `src/server/tasks/service.ts:53` | `createRepo` hardcodes `provider: "github"` | Minor |
| `src/server/pipeline/guardrails.ts:73,79` | Blocks `gh` and `$GITHUB_TOKEN` in agent commands | **Security-relevant** — must be widened, see §8 |
| `src/components/repo-manager.tsx`, `src/app/(dashboard)/{page,repos,settings}` | UI copy naming GitHub and `GITHUB_TOKEN` | Cosmetic |

Everything else — the workspace lifecycle, branch strategy, diffing, commit
handling, `redactRemote`, the state machine, the agents — is already
provider-agnostic.

---

## 3. Provider matrix

Facts marked **[verified]** were read from vendor documentation while writing
this spec. Facts marked **[assumed]** are the author's expectation and **must be
confirmed against a live account before implementation.**

### 3.1 Git-over-HTTPS credential

| Provider | Username | Secret | Notes |
|---|---|---|---|
| **GitHub** | `x-access-token` | PAT (classic or fine-grained) | Username ignored for PATs. **[verified — current behaviour in production]** |
| **GitLab** (SaaS + self-managed) | any non-empty string; `oauth2` is the documented example | PAT / project access token / group token | Docs: "can be any string value, must not be an empty string". **[verified]** |
| **Bitbucket Cloud** | `x-token-auth` | Repository / project / workspace access token | Mandatory username; `x-access-token` will fail. **[verified]** |
| **Bitbucket Cloud** (legacy) | Atlassian account username | App password | Requires the real username, so it cannot be a constant. **[assumed]** |
| **Azure DevOps** | ignored — Microsoft documents `Basic base64(":" + PAT)`, i.e. an empty username | PAT | URL-embedded form works in practice but is not the documented path. **[verified for the header form; assumed for the URL form]** |
| **Gitea / Forgejo** | account username or token name | PAT | **[assumed]** |

**Design consequence:** the username must become a per-provider (and, for
Bitbucket app passwords, per-connection) value rather than a constant.

**Azure DevOps caveat.** Because the documented mechanism is an
`Authorization` header rather than a URL component, the provider abstraction
must be able to return *either* an authenticated URL *or* a set of extra git
config arguments:

```
git -c http.extraHeader="Authorization: Basic <base64>" clone <clean-url>
```

This is also the more secure shape overall — the secret never enters a string
that git might echo into an error message — so it is worth considering as the
default transport for **all** providers, with the URL form as the fallback.

### 3.2 Repository URL shapes

| Provider | Clone URL | Notes |
|---|---|---|
| GitHub | `https://github.com/{owner}/{repo}.git` | |
| GitLab | `https://gitlab.com/{group}/[{subgroup}/]{project}.git` | Arbitrary subgroup nesting — `owner/repo` parsing does not hold |
| Bitbucket Cloud | `https://{user}@bitbucket.org/{workspace}/{repo}.git` | **Clone URL often already contains a username** |
| Azure DevOps | `https://dev.azure.com/{org}/{project}/_git/{repo}` | Also `https://{org}@dev.azure.com/...` and legacy `https://{org}.visualstudio.com/{project}/_git/{repo}` |

Two consequences:

- **`owner/repo` is not a universal identity.** GitLab needs a URL-encoded full
  path; Azure DevOps needs `{org, project, repo}`. The provider must own its own
  parsing and produce its own opaque identifier.
- **Existing usernames in clone URLs must be replaced, not appended.** The
  current `url.username = …` assignment already does the right thing here.

### 3.3 Pull request APIs

| Provider | Endpoint | Terminology |
|---|---|---|
| GitHub | `POST https://api.github.com/repos/{owner}/{repo}/pulls` | Pull request |
| GitLab | `POST {base}/api/v4/projects/{urlencoded-path}/merge_requests` | **Merge request** |
| Bitbucket Cloud | `POST https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/pullrequests` | Pull request |
| Azure DevOps | `POST https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1` | Pull request. Branches must be full refs: `refs/heads/{branch}` **[verified]** |

**Recommendation: drop the `gh` CLI and call REST directly for every provider,
including GitHub.** Reasons:

- It removes an external binary from the install requirements (the `gh`
  dependency is already a documented gap — it is not installed on the author's
  machine, so this path has never run against a live repository).
- Four provider CLIs (`gh`, `glab`, `az`, none for Bitbucket) is a worse
  dependency surface than one `fetch` per provider.
- It removes the need to pass a credential through a subprocess environment.
- The guardrail blocklist then only needs to block one thing — outbound network
  calls from agents — rather than an ever-growing list of CLI names.

### 3.4 Fallback "create a pull request" URL

Used when the API call fails, so the human can finish manually. All **[assumed]**:

| Provider | URL |
|---|---|
| GitHub | `{repo}/compare/{base}...{head}?expand=1` |
| GitLab | `{repo}/-/merge_requests/new?merge_request[source_branch]={head}&merge_request[target_branch]={base}` |
| Bitbucket | `{repo}/pull-requests/new?source={head}&dest={base}` |
| Azure DevOps | `{repo}/pullrequestcreate?sourceRef={head}&targetRef={base}` |

---

## 4. Proposed architecture

### 4.1 The provider interface

A single interface under `src/server/git/providers/`, one implementation per
provider, resolved from `repos.provider`. Everything provider-specific lives
behind it; `workspace.ts` and `execute.ts` learn nothing new.

```ts
export type GitCredential = {
  /** Username for HTTP Basic. Empty string means "omit". */
  username: string;
  secret: string;
};

export type GitTransport =
  /** Credential embedded in the remote URL. */
  | { kind: "url"; authenticatedUrl: string }
  /** Credential sent as an Authorization header via `git -c http.extraHeader`. */
  | { kind: "header"; cleanUrl: string; configArgs: string[] };

export type PullRequestRef = { url: string; id: string | number };

export interface RepositoryProvider {
  readonly id: ProviderId;            // "github" | "gitlab" | "bitbucket" | "azure_devops" | "generic"
  readonly displayName: string;
  /** "Pull request" vs "Merge request", for the UI. */
  readonly changeRequestNoun: string;

  /** True when this provider recognises the URL. Used to auto-detect on connect. */
  matches(repoUrl: string): boolean;

  /** Parses the URL into whatever identity the provider's API needs. */
  parse(repoUrl: string): ProviderRepoIdentity;

  /** Builds the authenticated transport for one git command. */
  transport(repoUrl: string, credential: GitCredential): GitTransport;

  /** Cheap reachability + permission check, run when a connection is saved. */
  verifyAccess(
    identity: ProviderRepoIdentity,
    credential: GitCredential,
  ): Promise<{ ok: true; defaultBranch?: string } | { ok: false; reason: string }>;

  /** Opens the change request. */
  createChangeRequest(input: {
    identity: ProviderRepoIdentity;
    credential: GitCredential;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;

  /** Web URL a human can open to create it by hand. */
  manualCreateUrl(repoUrl: string, baseBranch: string, headBranch: string): string;
}
```

`createPullRequest` in `pull-request.ts` becomes a thin dispatcher that resolves
the provider, resolves the credential, calls `createChangeRequest`, and falls
back to `manualCreateUrl` on failure — the same two-outcome contract the worker
already handles (`{ status: "created" } | { status: "manual" }`), so
`execute.ts` needs no change.

### 4.2 Credential resolution

**Constraint to preserve: secrets never enter the database.** (§6 and §13 of the
original spec.)

The proposal is **credential references**: the `repos` row stores the *name* of
an environment variable, never its value. The worker dereferences it at the
moment of use.

```
repos.credential_ref = "BITBUCKET_TOKEN_ACME"
                        │
                        └─► process.env.BITBUCKET_TOKEN_ACME  (worker only)
```

Resolution order when running a git command for a repo:

1. `repos.credential_ref`, if set.
2. The provider's conventional variable: `GITHUB_TOKEN`, `GITLAB_TOKEN`,
   `BITBUCKET_TOKEN`, `AZURE_DEVOPS_TOKEN`.
3. Fail with an actionable message naming the variable that was expected.

Rule 2 keeps every existing installation working with no configuration change.

The username is resolved the same way: a provider default (`x-token-auth` for
Bitbucket, `oauth2` for GitLab, `x-access-token` for GitHub, empty for Azure
DevOps), overridable per connection via `repos.credential_username` for the
cases that need a real account name (Bitbucket app passwords, Gitea).

**Validation on write.** `credential_ref` must match `^[A-Z][A-Z0-9_]*$` and be
rejected if it names a variable the pipeline reserves
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DATABASE_URL`, …). Without
that check, a repository connection becomes an arbitrary-environment-variable
read primitive for anyone who can reach the UI.

**Deliberately rejected alternatives:**

- *Encrypted secrets in SQLite.* Needs a key, which needs a home — either an env
  var (identical security to just holding the token in an env var, with more
  moving parts) or a keychain (platform-specific, and the app is cross-platform).
- *OS keychain via a native module.* Attractive for a desktop app, but it adds a
  native dependency to a project that already compiles `better-sqlite3`, and
  headless Docker deployment has no keychain. Worth revisiting if the product
  ever ships as an installable desktop app.
- *OAuth app per provider.* Correct for a hosted multi-user product; far too much
  machinery (callback URLs, refresh tokens, per-provider app registration) for a
  local single-user tool.

---

## 5. Data model changes

Additive only. No existing column changes type or meaning.

```sql
ALTER TABLE repos ADD COLUMN credential_ref TEXT;         -- env var NAME, never a value
ALTER TABLE repos ADD COLUMN credential_username TEXT;    -- overrides the provider default
ALTER TABLE repos ADD COLUMN api_base_url TEXT;           -- self-hosted GitLab/Gitea/Bitbucket DC
```

`repos.provider` widens from the literal `"github"` to
`"github" | "gitlab" | "bitbucket" | "azure_devops" | "generic"`, keeping
`'github'` as the default so existing rows remain valid.

`generic` is the escape hatch: clone, branch, commit and push work, but change
requests fall back to `manualCreateUrl` with a `null` URL and the worker reports
"branch pushed, open the pull request manually". This is what makes unknown or
internal git servers usable on day one.

> The project bootstraps its schema with `CREATE TABLE IF NOT EXISTS`
> (`src/server/db/bootstrap.sql.ts`), which does not apply `ALTER TABLE` to an
> existing database. This change is the point at which a real migration runner
> — `drizzle-kit generate` plus `migrate()` at startup — has to replace the
> bootstrap file. That is a prerequisite task, not a side effect.

---

## 6. API changes

| Route | Change |
|---|---|
| `POST /api/repos` | Accepts `provider` (optional — auto-detected from the URL), `credentialRef`, `credentialUsername`, `apiBaseUrl` |
| `GET /api/repos` | Returns `provider`, `credentialRef`, and a computed `credentialPresent: boolean` — **never the secret** |
| `GET /api/repos/:id` | Access check runs through `provider.verifyAccess` |
| `GET /api/settings` | `githubTokenPresent` becomes `credentials: { [provider]: { variable, present } }`. Keep the old field for one release if anything external reads it. |

`createRepoSchema` loses the `github.com` refinement and gains:
- a `provider` enum, defaulting to the auto-detected value;
- `credentialRef` validated against the naming rule and the reserved list;
- a rule that `provider: "generic"` requires an explicit `apiBaseUrl` or accepts
  none at all (no API calls will be made).

---

## 7. UI changes

- **Repositories** — provider selector (auto-selected from the pasted URL), a
  credential-variable field with a per-provider placeholder, and a per-row
  badge: provider name plus *credential found / not found*. The connection test
  reports which check failed: DNS, auth, or permission.
- **Settings** — replace the single "GITHUB_TOKEN present" badge with one row
  per provider actually in use, each showing the variable name and whether it
  resolves.
- **Task detail** — "Open pull request" becomes
  `Open {provider.changeRequestNoun}` so GitLab tasks read "Open merge request".
- **Dashboard setup notice** — warn per configured provider rather than about
  `GITHUB_TOKEN` specifically.

---

## 8. Guardrail changes (security-relevant)

`src/server/pipeline/guardrails.ts` currently blocks `gh` and
`$GITHUB_TOKEN`. Widening a blocklist per provider is the wrong shape — it fails
open on whatever is not yet listed.

Three changes:

1. **Block the credential variables generically.** Replace the enumerated
   pattern with one that matches any variable whose name contains `TOKEN`,
   `SECRET`, `PASSWORD`, `KEY` or `CREDENTIAL`, plus every name currently
   referenced by a `repos.credential_ref` row.
2. **Block provider CLIs as a family**: `gh`, `glab`, `az`, `tf`, `bb`. Cheap,
   and mostly moot once §3.3 removes the CLI dependency.
3. **Prefer denying outbound network commands wholesale** for read-only roles.
   `curl` and `wget` are already only reachable via Bash, which the Architect and
   QA hold under an allowlist that excludes them — but the Developer has
   unrestricted Bash. Blocking a Developer from `curl`-ing a package registry
   would break legitimate builds, so this needs judgement rather than a blanket
   rule. **Open question — see §12.**

Also worth stating explicitly in the spec: the `x-access-token` username is not
a secret and appearing in a log is harmless. `redactRemote` targets the
`user:password@` pair and is provider-agnostic; it needs no change.

---

## 9. Compatibility

An existing installation must keep working untouched:

- `repos.provider` defaults to `'github'`; existing rows are already correct.
- `credential_ref` is `NULL` on existing rows → resolution rule 2 falls back to
  `GITHUB_TOKEN` → identical behaviour.
- The GitHub provider must reproduce today's semantics exactly, including the
  `x-access-token` username and the compare-URL fallback.

The only visible change for a GitHub-only user is that PR creation stops
shelling out to `gh`. That is a behaviour change worth calling out in the
release notes, and it is strictly an improvement: it removes an optional
dependency whose absence currently degrades the delivery step.

---

## 10. Phasing

**Phase A — extract the abstraction, no new providers.**
Introduce `RepositoryProvider`, implement `GitHubProvider` against it, move PR
creation from `gh` to the REST API, add the migration runner, add the credential
reference resolution with fallback. *Externally observable behaviour: unchanged
except for dropping `gh`.* This phase is independently valuable and carries all
the risk of regression, so it ships alone.

**Phase B — Bitbucket Cloud and GitLab.**
Two providers that use the same Basic-over-HTTPS transport as GitHub, differing
only in username and API. Validates the abstraction against a real second and
third case.

**Phase C — Azure DevOps.**
Held back deliberately: it needs the `extraHeader` transport variant, a
three-part identity (`org/project/repo`), full `refs/heads/…` branch names, and
has a second legacy URL form. If the abstraction survives Azure DevOps, it is
correct.

**Phase D — `generic` provider and self-hosted.**
Custom `api_base_url`, push-only delivery with a manual change-request step,
optional support for self-hosted GitLab/Gitea API dialects.

---

## 11. Test plan

- **Unit, no network** — per provider: URL matching and parsing (including
  GitLab subgroups, Azure DevOps legacy `visualstudio.com`, Bitbucket clone URLs
  that already carry a username), transport construction, and
  `manualCreateUrl`. Assert that the secret appears in the authenticated URL and
  **never** in the clean URL, and that `redactRemote` scrubs each provider's
  form.
- **Unit** — credential resolution: explicit ref, provider fallback, missing
  variable, reserved-name rejection, malformed name rejection.
- **Contract tests against a recorded fixture** — one captured request/response
  per provider for `verifyAccess` and `createChangeRequest`, so the API shapes
  are pinned without hitting the network in CI.
- **Manual, one throwaway repository per provider** — full pipeline through to a
  real change request. The **[assumed]** rows in §3 are confirmed or corrected
  here; this is the only step that can confirm them.
- **Regression** — the existing GitHub path, end to end, before and after
  Phase A.

---

## 12. Risks and open questions

| Risk | Assessment |
|---|---|
| An **[assumed]** row in §3 is wrong | Contained: each provider is an isolated module, and the manual test in §11 catches it before release |
| `x-access-token` silently works on a provider today and the change breaks it | Low — only GitHub is reachable today, blocked by the Zod refinement for everything else |
| Widening `provider` breaks the existing type union | Compile-time, caught immediately |
| Credential-reference field used to read arbitrary env vars | **Real.** Mitigated by the naming rule and reserved list in §4.2. Must not be skipped |
| Bitbucket app passwords need a real username | Handled by `credential_username`; also note Atlassian has been migrating app passwords to API tokens — confirm which is current before implementing |
| Migration runner introduction | The riskiest infrastructure change here; it is why Phase A ships alone |

**Open questions for the product owner:**

1. **Should the Developer role be allowed outbound network access?** Today it
   can `curl`. Package installation during a build needs it; exfiltrating a
   token does too — although §8.1 means there is no token in the agent's
   environment to exfiltrate. Options: leave as is, allowlist known registry
   hosts, or run the Developer's Bash inside a network-restricted sandbox
   (the Agent SDK exposes a `sandbox` option that may cover this).
2. **Is SSH-key authentication wanted as an alternative to tokens?** It is the
   norm in some enterprise setups and sidesteps token expiry entirely, but it
   introduces key management and an `~/.ssh` surface the guardrails currently
   block outright.
3. **How many credentials per provider realistically?** The design supports one
   per connection. If one per provider is genuinely enough, `credential_ref` can
   be dropped and the model simplifies to four conventional env vars.
4. **Is Bitbucket Data Center / Server (self-hosted) in scope?** Its REST API is
   a different dialect from Bitbucket Cloud's and would need a fifth provider,
   not a base-URL variant of the fourth.
