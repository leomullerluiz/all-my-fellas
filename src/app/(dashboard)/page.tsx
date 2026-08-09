import Link from "next/link";

import { AutoRefresh } from "@/components/auto-refresh";
import { BatchSelectionProvider, BatchStartButton } from "@/components/batch-start";
import { NeedsMePanel, type NeedsMeTask } from "@/components/needs-me-panel";
import { SavedViews, type SavedViewKey } from "@/components/saved-views";
import { TaskBoard, type BoardTask } from "@/components/task-board";
import { TaskFilterBar } from "@/components/task-filter-bar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { UsageBar } from "@/components/usage-bar";
import {
  defaultDateRange,
  filterBoardTasks,
  isOpenStatus,
  parseDateRangeParams,
  parseListFilters,
  type DateRangeFilter,
} from "@/lib/task-filter";
import { changeRequestNounFor } from "@/lib/provider-copy";
import { currentTimeMs, formatCost } from "@/lib/utils";
import { resolveProviderAuth } from "@/server/config/env";
import { credentialSource } from "@/server/git/credentials";
import { providerFor, supportedProviderNames } from "@/server/git/providers";
import { MAX_JOB_ATTEMPTS } from "@/server/jobs/queue";
import { executionStateFor, executionStates } from "@/server/pipeline/execution";
import { capacity } from "@/server/pipeline/orchestrator";
import { sortByPriorityThenDifficulty } from "@/server/pipeline/task-ranking";
import { type Gate, isGate } from "@/server/pipeline/stages";
import { getSettings } from "@/server/settings/store";
import {
  activeStageRunStarts,
  costByTaskId,
  dependenciesByTaskId,
  listRepos,
  listTasks,
  queuedTasks,
} from "@/server/tasks/service";
import { resolveQuotaStatus, spendToday } from "@/server/usage/quota";
import { resolveWorkerHealth } from "@/server/worker/health";

// The board reflects worker state that changes between requests, so it must be
// rendered per request rather than prerendered at build time.
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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
  const rawStart = first(search.start);
  const rawEnd = first(search.end);
  // An invalid or missing range falls back to the default ("today" —
  // see `defaultDateRange`) rather than 400ing: this filter is a view
  // convenience, not an API contract worth failing a page load over.
  const customRange = parseDateRangeParams(rawStart, rawEnd);
  // S2 §4.1 — `?range=all` (what Reset now navigates to) is the explicit
  // "everything" state, distinct from the no-params default.
  const range: DateRangeFilter = search.range === "all" ? "all" : (customRange ?? defaultDateRange());
  const includeArchived = first(search.archived) === "1";
  // "Active" saved view: every open-status task, regardless of date — a
  // narrower read than the default's "open + today", applied client-side
  // (JS) against the already-fetched set rather than a fifth SQL filter for
  // a chip that exists purely as a bookmark (§4.3).
  const activeOnly = first(search.view) === "active";

  const listFilters = parseListFilters(search);
  const repos = listRepos();

  // One derivation, read once per render — see `execution.ts`. `idle` is the
  // default for every task this map has no entry for (everything not
  // admitted), which is most of them.
  const execution = executionStates();
  // S9.1 — one query each for cost and dependencies, not one per task.
  const costs = costByTaskId();
  const dependencies = dependenciesByTaskId();
  const runningStarts = activeStageRunStarts();

  // S7 §8.1/§8.2 — the real promotion order, computed over *every* `on_queue`
  // task (not just whatever the date/search filters below let through), so a
  // card's "#N in queue" position stays honest even when the board is
  // filtered to a subset.
  const queuePositionById = new Map<string, number>();
  sortByPriorityThenDifficulty([...queuedTasks()].sort((a, b) => a.updatedAt - b.updatedAt)).forEach(
    (task, index) => queuePositionById.set(task.id, index + 1),
  );

  const now = currentTimeMs();
  const allTasks: BoardTask[] = listTasks({
    status: listFilters.status,
    repoId: listFilters.repoId,
    priority: listFilters.priority,
    q: listFilters.q,
    includeArchived,
  }).map((task) => ({
    ...task,
    costUsd: costs.get(task.id) ?? 0,
    dependsOn: dependencies.get(task.id) ?? [],
    execution: executionStateFor(task.id, execution),
    runningStageStartedAt: runningStarts.get(task.id) ?? null,
    queuePosition: queuePositionById.get(task.id) ?? null,
  }));
  // S1/S2: today's tasks (or the applied custom range, or "everything") plus
  // every open/active task regardless of date — see `filterBoardTasks`. The
  // header counters below are derived from this filtered set, not
  // `allTasks`, per S1's AC.
  let tasks = filterBoardTasks(allTasks, range);
  if (activeOnly) tasks = tasks.filter((task) => isOpenStatus(task.status));

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
  const quota = resolveQuotaStatus();

  // S6 §6.2 — every task waiting on a human decision, cross-task. A plain
  // `listTasks` call, independent of the board's own date/search filters:
  // what needs you does not stop needing you because it's outside today's
  // window.
  const needsMe: NeedsMeTask[] = listTasks({ status: "awaiting_gate" })
    .filter((task): task is typeof task & { currentStage: Gate } => isGate(task.currentStage))
    .map((task) => ({
      id: task.id,
      title: task.title,
      currentStage: task.currentStage,
      updatedAt: task.updatedAt,
    }));

  // S5 §9.2 — back off the refresh interval once nothing on the board is
  // live, derived from data already rendered (no extra fetch). `~7.5x` the
  // fast interval lands on 30s at the 4000ms default.
  const settings = getSettings();
  const hasLiveTask = tasks.some((task) => task.status === "running" || task.status === "awaiting_gate");
  const refreshIntervalMs = hasLiveTask ? settings.boardRefreshMs : Math.round(settings.boardRefreshMs * 7.5);

  const savedView: SavedViewKey | null =
    search.status === "awaiting_gate" && search.range === "all" && !search.view
      ? "needs-me"
      : activeOnly
        ? "active"
        : search.range === "all" &&
            !listFilters.status &&
            !listFilters.repoId &&
            !listFilters.priority &&
            !listFilters.q
          ? "everything"
          : null;

  return (
    <BatchSelectionProvider
      tasks={tasks.map((task) => ({ id: task.id, status: task.status, archivedAt: task.archivedAt }))}
    >
      <AutoRefresh intervalMs={refreshIntervalMs} />

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

      <SavedViews active={savedView} />

      <TaskFilterBar
        initialStart={customRange ? rawStart : undefined}
        initialEnd={customRange ? rawEnd : undefined}
        initialQ={listFilters.q}
        initialRepo={listFilters.repoId}
        initialPriority={listFilters.priority}
        initialStatus={listFilters.status}
        repos={repos}
      />

      <SetupNotice />

      <NeedsMePanel tasks={needsMe} now={now} />

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
        <TaskBoard tasks={tasks} capacity={slots} maxJobAttempts={MAX_JOB_ATTEMPTS} now={now} />
      )}

      <UsageBar spendToday={todaySpend} quota={quota} />
    </BatchSelectionProvider>
  );
}
