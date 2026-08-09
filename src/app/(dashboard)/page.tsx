import Link from "next/link";

import { AutoRefresh } from "@/components/auto-refresh";
import { BatchSelectionProvider, BatchStartButton } from "@/components/batch-start";
import { TaskBoard, type BoardTask } from "@/components/task-board";
import { TaskFilterBar } from "@/components/task-filter-bar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { UsageBar } from "@/components/usage-bar";
import { changeRequestNounFor } from "@/lib/provider-copy";
import { defaultDateRange, filterBoardTasks, parseDateRangeParams } from "@/lib/task-filter";
import { formatCost } from "@/lib/utils";
import { resolveProviderAuth } from "@/server/config/env";
import { credentialSource } from "@/server/git/credentials";
import { providerFor, supportedProviderNames } from "@/server/git/providers";
import { MAX_JOB_ATTEMPTS } from "@/server/jobs/queue";
import { executionStateFor, executionStates } from "@/server/pipeline/execution";
import { capacity } from "@/server/pipeline/orchestrator";
import { listDependencies, listRepos, listTasks, totalCostForTask } from "@/server/tasks/service";
import { resolveQuotaStatus, spendToday } from "@/server/usage/quota";
import { resolveWorkerHealth } from "@/server/worker/health";

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

  // §7.4: the one failure that stops everything else — a dead or hung
  // worker leaves every "running" task pulsing forever with no other signal.
  const health = resolveWorkerHealth();
  if (health.state === "never_started") {
    problems.push(
      "The worker process has never reported in. Start it with npm run dev:worker (or the worker container).",
    );
  } else if (health.state === "lagging") {
    problems.push("The worker hasn't reported in for a bit — it may be busy, or about to become unresponsive.");
  } else if (health.state === "stale") {
    problems.push(
      health.interrupted
        ? `The worker appears to have died while running task ${health.activeTaskId}. Restart it to resume — the job will pick up where it left off.`
        : "The worker appears to have died. Restart it to resume processing tasks.",
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

export default async function DashboardPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const rawStart = Array.isArray(search.start) ? search.start[0] : search.start;
  const rawEnd = Array.isArray(search.end) ? search.end[0] : search.end;
  // An invalid or missing range falls back to S1's default ("today" —
  // see `defaultDateRange`) rather than 400ing: this filter is a view
  // convenience, not an API contract worth failing a page load over.
  const customRange = parseDateRangeParams(rawStart, rawEnd);
  const range = customRange ?? defaultDateRange();

  const repos = listRepos();
  // One derivation, read once per render — see `execution.ts`. `idle` is the
  // default for every task this map has no entry for (everything not
  // admitted), which is most of them.
  const execution = executionStates();
  const allTasks: BoardTask[] = listTasks().map((task) => ({
    ...task,
    costUsd: totalCostForTask(task.id),
    dependsOn: listDependencies(task.id),
    execution: executionStateFor(task.id, execution),
  }));
  // S1/S2: today's tasks (or the applied custom range) plus every open/active
  // task regardless of date — see `filterBoardTasks`. The header counters
  // below are derived from this filtered set, not `allTasks`, per S1's AC.
  const tasks = filterBoardTasks(allTasks, range);

  const slots = capacity();
  const notStarted = tasks.filter((task) => task.currentStage === "CREATED").length;
  const waiting = tasks.filter((task) => task.status === "awaiting_gate").length;
  const spend = tasks.reduce((sum, task) => sum + task.costUsd, 0);
  // The true numbers behind "N of M slots in use" — see `execution.ts` and
  // `spec-execution-honesty.md` §6.5. `waitingForWorker` is only meaningful
  // once more than one task can be admitted at once; below that the board's
  // own card-level rule (`TaskBoard`'s `showQueuePosition`) already suppresses
  // the per-card wording, and the header follows the same rule so the two
  // never disagree.
  const inFlightCount = tasks.filter((task) => task.execution.kind === "in_flight").length;
  const waitingForWorker =
    slots.limit > 1 ? tasks.filter((task) => task.execution.kind === "waiting_for_worker").length : 0;

  // S1/S2/S3's bottom-of-page bar. Recomputed on every request that renders
  // this route, same as everything else here — no separate polling.
  const todaySpend = spendToday();
  const quotas = resolveQuotaStatus();
  const claudeAuthMode = resolveProviderAuth().mode;

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
            {/* The true number first — "N of M slots in use" counts admitted
                tasks, not tasks the worker is actually executing, and the two
                diverge above `maxParallelTasks = 1` — see §6.5. */}
            {inFlightCount} running
            {waitingForWorker > 0 ? ` · ${waitingForWorker} waiting for the worker` : ""} ·{" "}
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

      <TaskFilterBar
        initialStart={customRange ? rawStart : undefined}
        initialEnd={customRange ? rawEnd : undefined}
      />

      <SetupNotice />

      {repos.length === 0 ? (
        <EmptyState
          title="Connect a repository first"
          description={`The pipeline reads real code to estimate the work and delivers the result as a change request. Connect a repository on ${supportedProviderNames()} — or any git server, through the generic provider.`}
          action={
            <Link href="/repos">
              <Button variant="secondary">Add a repository</Button>
            </Link>
          }
        />
      ) : allTasks.length === 0 ? (
        <EmptyState
          title="No tasks yet"
          description={`Describe a feature and the pipeline will refine it, plan it, build it, review it, and open a ${changeRequestNounFor(
            repos.map((repo) => providerFor(repo.provider).changeRequestNoun),
          )}. Nothing starts until you say so.`}
          action={
            <Link href="/tasks/new">
              <Button>Create the first task</Button>
            </Link>
          }
        />
      ) : (
        <TaskBoard tasks={tasks} capacity={slots} maxJobAttempts={MAX_JOB_ATTEMPTS} />
      )}

      <UsageBar spendToday={todaySpend} authMode={claudeAuthMode} quotas={quotas} />
    </BatchSelectionProvider>
  );
}
