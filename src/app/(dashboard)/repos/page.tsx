import { RepoManager, type ProviderOption, type RepoRowView } from "@/components/repo-manager";
import { credentialSource } from "@/server/git/credentials";
import { PROVIDERS, providerFor } from "@/server/git/providers";
import { listRepos, listTasks } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  const tasks = listTasks();

  const repos: RepoRowView[] = listRepos().map((repo) => {
    const provider = providerFor(repo.provider);
    return {
      id: repo.id,
      name: repo.name,
      url: repo.url,
      provider: repo.provider,
      providerName: provider.displayName,
      defaultBranch: repo.defaultBranch,
      createdAt: repo.createdAt,
      taskCount: tasks.filter((task) => task.repoId === repo.id).length,
      hasContext: repo.context != null,
      credential: credentialSource({
        provider,
        credentialRef: repo.credentialRef,
        credentialUsername: repo.credentialUsername,
      }),
    };
  });

  const providers: ProviderOption[] = PROVIDERS.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    defaultCredentialEnvVar: provider.defaultCredentialEnvVar,
    exampleUrl: provider.exampleUrl,
    // `generic` never claims a URL, so it can only be chosen by hand.
    autoDetectable: provider.id !== "generic",
  }));

  return (
    <>
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
        <p className="mt-1 text-xs text-muted">
          GitHub, GitLab, Bitbucket Cloud and Azure DevOps are supported directly; anything
          else works through the generic provider, which clones and pushes but leaves the
          pull request for you to open.
        </p>
      </div>
      <RepoManager repos={repos} providers={providers} />
    </>
  );
}
