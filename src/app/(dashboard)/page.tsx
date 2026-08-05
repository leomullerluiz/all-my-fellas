import Link from "next/link";

import { AutoRefresh } from "@/components/auto-refresh";
import { BatchSelectionProvider, BatchStartButton } from "@/components/batch-start";
import { TaskBoard, type BoardTask } from "@/components/task-board";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { UsageBar } from "@/components/usage-bar";
import { formatCost } from "@/lib/utils";
import { resolveProviderAuth } from "@/server/config/env";
import { credentialSource } from "@/server/git/credentials";
import { providerFor } from "@/server/git/providers";
import { capacity } from "@/server/pipeline/orchestrator";
import { listDependencies, listRepos, listTasks, totalCostForTask } from "@/server/tasks/service";
import { resolveQuotaStatus, spendToday } from "@/server/usage/quota";

// The board reflects worker state that changes between requests, so it must be
// rendered per request rather than prerendered at build time.
export const dynamic = "force-dynamic";

function SetupNotice() {
  const auth = resolveProviderAuth();
  const problems: string[] = [];

  if (auth.mode === "missing") {
    problems.push(
      "No Claude credential found. Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in .env.",
    );
  }

  // Warn per connection that is actually configured, rather than about
  // GITHUB_TOKEN specifically — a GitLab-only install does not need it.
  for (const repo of listRepos()) {
    const provider = providerFor(repo.provider);
    const credential = credentialSource({
      provider,
      credentialRef: repo.credentialRef,
      credentialUsername: repo.credentialUsername,
    });
    if (!credential.present) {
      problems.push(
        `${repo.name}: ${credential.variable} is not set, so cloning private repositories ` +
          `and opening a ${provider.changeRequestNoun} will fail.`,
      );
    }
  }

  if (problems.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <p className="text-sm font-medium text-warning">Setup incomplete</p>
      <ul className="mt-1 list-inside list-disc text-xs text-warning/90">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

export default async function DashboardPage() {
  const repos = listRepos();
  const tasks: BoardTask[] = listTasks().map((task) => ({
    ...task,
    costUsd: totalCostForTask(task.id),
    dependsOn: listDependencies(task.id),
  }));

  const slots = capacity();
  const notStarted = tasks.filter((task) => task.currentStage === "CREATED").length;
  const waiting = tasks.filter((task) => task.status === "awaiting_gate").length;
  const spend = tasks.reduce((sum, task) => sum + task.costUsd, 0);

  // S1/S2/S3's bottom-of-page bar. Recomputed on every request that renders
  // this route, same as everything else here — no separate polling.
  const todaySpend = spendToday();
  const quota = resolveQuotaStatus();

  // A digest of every task's id/stage/status, recomputed on each request
  // that renders this route (full load or `router.refresh()`). Changes
  // whenever a task's state actually moves — which is what makes a
  // previously checked task's selection stale — so `BatchSelectionProvider`
  // can reset it (S1) without needing an impure, always-different value.
  const boardVersion = tasks.map((task) => `${task.id}:${task.currentStage}:${task.status}`).join("|");

  return (
    <BatchSelectionProvider boardVersion={boardVersion}>
      <AutoRefresh />

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Pipeline</h1>
          <p className="mt-1 text-xs text-muted">
            {slots.active} of {slots.limit} slot{slots.limit === 1 ? "" : "s"} in use ·{" "}
            {notStarted} not started · {waiting} waiting for approval ·{" "}
            {formatCost(spend)} spent in total
          </p>
        </div>
        <div className="flex items-start gap-2">
          <BatchStartButton />
          <Link href="/tasks/new">
            <Button>New task</Button>
          </Link>
        </div>
      </div>

      <SetupNotice />

      {repos.length === 0 ? (
        <EmptyState
          title="Connect a repository first"
          description="The pipeline reads real code to estimate the work and delivers the result as a pull request, so it needs a GitHub repository to work against."
          action={
            <Link href="/repos">
              <Button variant="secondary">Add a repository</Button>
            </Link>
          }
        />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No tasks yet"
          description="Describe a feature and the pipeline will refine it, plan it, build it, review it, and open a pull request. Nothing starts until you say so."
          action={
            <Link href="/tasks/new">
              <Button>Create the first task</Button>
            </Link>
          }
        />
      ) : (
        <TaskBoard tasks={tasks} capacity={slots} />
      )}

      <UsageBar spendToday={todaySpend} quota={quota} />
    </BatchSelectionProvider>
  );
}
