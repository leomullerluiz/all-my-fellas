import type { GitCredential, ProviderId, RepositoryProvider } from "./providers/types";

/**
 * Credential resolution.
 *
 * Secrets never enter the database. A repository connection stores the *name*
 * of an environment variable; the value is dereferenced here, in the process
 * that needs it, at the moment it runs a command.
 */

/**
 * Variables a connection may never name.
 *
 * Without this, the credential-reference field is an
 * arbitrary-environment-variable read primitive for anyone who reaches the UI:
 * point a connection at `ANTHROPIC_API_KEY` and the value is handed to a remote
 * git server on the next push.
 */
const RESERVED_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DATABASE_URL",
  "WORKSPACES_DIR",
  "PATH",
  "HOME",
  "USERPROFILE",
  "NODE_OPTIONS",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/** Shell-style variable names only: no lowercase, no punctuation, no traversal. */
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export type CredentialRefProblem = "malformed" | "reserved";

/** Validates a credential reference before it is stored. */
export function validateCredentialRef(
  ref: string,
): { ok: true } | { ok: false; problem: CredentialRefProblem; message: string } {
  if (!ENV_VAR_PATTERN.test(ref)) {
    return {
      ok: false,
      problem: "malformed",
      message:
        "A credential variable name must be uppercase letters, digits and underscores, " +
        "starting with a letter — for example BITBUCKET_TOKEN_ACME.",
    };
  }
  if (RESERVED_ENV_VARS.has(ref)) {
    return {
      ok: false,
      problem: "reserved",
      message: `${ref} is reserved by the pipeline and cannot be used as a repository credential.`,
    };
  }
  return { ok: true };
}

export type CredentialSource = {
  /** Environment variable the secret was read from. */
  variable: string;
  /** Whether that variable is actually set. */
  present: boolean;
};

export type CredentialTarget = {
  provider: RepositoryProvider;
  /** `repos.credential_ref`, when the connection names one. */
  credentialRef: string | null;
  /** `repos.credential_username`, for account-name credentials. */
  credentialUsername: string | null;
};

/**
 * Which variable a connection reads, whether or not it is set.
 *
 * An explicit reference wins; otherwise the provider's conventional variable,
 * which is what keeps existing GitHub-only installations working unchanged.
 */
export function credentialSource(target: CredentialTarget): CredentialSource {
  const variable = target.credentialRef ?? target.provider.defaultCredentialEnvVar;
  const value = process.env[variable];
  return { variable, present: value !== undefined && value.trim() !== "" };
}

export class MissingCredentialError extends Error {
  constructor(readonly variable: string) {
    super(
      `No credential found: set ${variable} in your environment, or point this ` +
        `repository at a different variable in Settings → Repositories.`,
    );
    this.name = "MissingCredentialError";
  }
}

/**
 * Reads the secret. Returns `null` when the variable is unset — callers that
 * genuinely require one use {@link requireCredential} instead.
 *
 * Never logged, never persisted, never placed in an agent's environment.
 */
export function resolveCredential(target: CredentialTarget): GitCredential | null {
  const { variable, present } = credentialSource(target);
  if (!present) return null;

  return {
    username: target.credentialUsername?.trim() || target.provider.defaultCredentialUsername,
    secret: (process.env[variable] as string).trim(),
  };
}

/** @throws {MissingCredentialError} when the variable is unset. */
export function requireCredential(target: CredentialTarget): GitCredential {
  const credential = resolveCredential(target);
  if (!credential) throw new MissingCredentialError(credentialSource(target).variable);
  return credential;
}

/** Conventional variable per provider, for the Settings screen. */
export function conventionalEnvVars(
  providers: readonly RepositoryProvider[],
): Array<{ provider: ProviderId; variable: string; present: boolean }> {
  return providers
    .filter((provider) => provider.defaultCredentialEnvVar !== "")
    .map((provider) => {
      const value = process.env[provider.defaultCredentialEnvVar];
      return {
        provider: provider.id,
        variable: provider.defaultCredentialEnvVar,
        present: value !== undefined && value.trim() !== "",
      };
    });
}

/**
 * Every variable name a repository connection currently points at.
 *
 * Feeds the agent guardrail so a credential the user configured cannot be read
 * back out through a shell command.
 */
export function configuredCredentialVariables(refs: Array<string | null>): string[] {
  return [...new Set(refs.filter((ref): ref is string => ref !== null && ref !== ""))];
}
