import { azureDevOpsProvider } from "./azure-devops";
import { bitbucketProvider } from "./bitbucket";
import { genericProvider } from "./generic";
import { githubProvider } from "./github";
import { gitlabProvider } from "./gitlab";
import type { ProviderId, RepositoryProvider } from "./types";

/**
 * The provider registry.
 *
 * Order matters for {@link detectProvider}: the first provider that claims a
 * URL wins, and `generic` never claims one — it is chosen explicitly, or it
 * would swallow every URL before a real provider could match.
 */
export const PROVIDERS: readonly RepositoryProvider[] = [
  githubProvider,
  gitlabProvider,
  bitbucketProvider,
  azureDevOpsProvider,
  genericProvider,
];

const BY_ID = new Map<ProviderId, RepositoryProvider>(
  PROVIDERS.map((provider) => [provider.id, provider]),
);

/** Falls back to `generic` so an unrecognised stored value cannot crash a page. */
export function providerFor(id: ProviderId | string): RepositoryProvider {
  return BY_ID.get(id as ProviderId) ?? genericProvider;
}

/** Auto-detects the provider from a repository URL, or `null` if none claims it. */
export function detectProvider(repoUrl: string): RepositoryProvider | null {
  return PROVIDERS.find((provider) => provider.matches(repoUrl)) ?? null;
}

/**
 * "GitHub, GitLab, Bitbucket Cloud or Azure DevOps" — the providers that claim
 * a URL directly, joined for a zero-repo empty state that has no connection
 * to read a display name from. Naming them here is an enumeration, not a
 * claim that only one is supported — see `spec-execution-honesty.md` §8's
 * distinction for `site/`, applied the same way server-side.
 *
 * `generic` is left out: it never claims a URL, so listing it here would
 * misstate what "auto-detected" means.
 */
export function supportedProviderNames(): string {
  const names = PROVIDERS.filter((provider) => provider.id !== "generic").map(
    (provider) => provider.displayName,
  );
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

export {
  azureDevOpsProvider,
  bitbucketProvider,
  genericProvider,
  githubProvider,
  gitlabProvider,
};
export type { ProviderId, RepositoryProvider };
