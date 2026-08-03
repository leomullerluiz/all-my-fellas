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

export {
  azureDevOpsProvider,
  bitbucketProvider,
  genericProvider,
  githubProvider,
  gitlabProvider,
};
export type { ProviderId, RepositoryProvider };
