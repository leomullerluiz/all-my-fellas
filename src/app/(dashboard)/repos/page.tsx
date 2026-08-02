import { RepoManager, type RepoRowView } from "@/components/repo-manager";
import { hasGithubToken } from "@/server/config/env";
import { listRepos, listTasks } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  const tasks = listTasks();
  const repos: RepoRowView[] = listRepos().map((repo) => ({
    id: repo.id,
    name: repo.name,
    url: repo.url,
    defaultBranch: repo.defaultBranch,
    createdAt: repo.createdAt,
    taskCount: tasks.filter((task) => task.repoId === repo.id).length,
  }));

  return (
    <>
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
        <p className="mt-1 text-xs text-muted">
          Only GitHub is supported in this release. Each task clones its repository into an
          isolated workspace and delivers the result as a pull request.
        </p>
      </div>
      <RepoManager repos={repos} githubTokenPresent={hasGithubToken()} />
    </>
  );
}
