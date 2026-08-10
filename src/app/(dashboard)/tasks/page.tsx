import Link from "next/link";

import { TaskFilterBar } from "@/components/task-filter-bar";
import { SORT_KEYS, TaskTable, type SortKey, type TaskTableRow } from "@/components/task-table";
import {
  defaultDateRange,
  filterBoardTasks,
  parseDateRangeParams,
  parseListFilters,
  type DateRangeFilter,
} from "@/lib/task-filter";
import { currentTimeMs } from "@/lib/utils";
import { costByTaskId, listRepos, listTasks } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/tasks` — S9 §4.5's list view: a table sharing the board's filter state
 * (`?q=`, `?repo=`, `?priority=`, `?status=`, the date range) plus its own
 * sort (`?sort=`/`?dir=`) and pagination (`?page=`). The board answers
 * "what is happening now"; this answers "find the thing" — a kanban column
 * past `COLUMN_CARD_LIMIT` links here pre-filtered (`task-board.tsx`).
 */
export default async function TasksListPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const repos = listRepos();
  const filters = parseListFilters(search);

  const rawStart = first(search.start);
  const rawEnd = first(search.end);
  const customRange = parseDateRangeParams(rawStart, rawEnd);
  const range: DateRangeFilter = search.range === "all" ? "all" : (customRange ?? defaultDateRange());

  // S3 §5.2 — hidden by default, filterable back in with `?archived=1`, same
  // as the board.
  const includeArchived = first(search.archived) === "1";
  const tasksWithRepo = listTasks({
    status: filters.status,
    repoId: filters.repoId,
    priority: filters.priority,
    q: filters.q,
    includeArchived,
  });
  const costs = costByTaskId();
  const filtered = filterBoardTasks(tasksWithRepo, range);

  const rawSort = first(search.sort);
  const sort: SortKey = (SORT_KEYS as readonly string[]).includes(rawSort ?? "") ? (rawSort as SortKey) : "age";
  const dir: "asc" | "desc" = first(search.dir) === "asc" ? "asc" : "desc";

  const rows: TaskTableRow[] = filtered.map((task) => ({
    id: task.id,
    title: task.title,
    repoName: task.repo.name,
    stage: task.currentStage,
    status: task.status,
    createdAt: task.createdAt,
    costUsd: costs.get(task.id) ?? 0,
  }));

  rows.sort((a, b) => {
    let delta = 0;
    switch (sort) {
      case "title":
        delta = a.title.localeCompare(b.title);
        break;
      case "repo":
        delta = a.repoName.localeCompare(b.repoName);
        break;
      case "status":
        delta = a.status.localeCompare(b.status);
        break;
      case "age":
        delta = a.createdAt - b.createdAt;
        break;
      case "cost":
        delta = a.costUsd - b.costUsd;
        break;
    }
    return dir === "asc" ? delta : -delta;
  });

  const rawPage = Number(first(search.page) ?? "1");
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = rows.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const filterParams = new URLSearchParams();
  if (filters.q) filterParams.set("q", filters.q);
  if (filters.repoId) filterParams.set("repo", filters.repoId);
  if (filters.priority) filterParams.set("priority", filters.priority);
  if (filters.status) filterParams.set("status", filters.status);
  if (includeArchived) filterParams.set("archived", "1");
  if (range === "all") filterParams.set("range", "all");
  else if (customRange) {
    filterParams.set("start", rawStart!);
    filterParams.set("end", rawEnd!);
  }
  const searchPrefix = filterParams.toString();

  const pageHref = (targetPage: number) => {
    const params = new URLSearchParams(filterParams);
    params.set("sort", sort);
    params.set("dir", dir);
    params.set("page", String(targetPage));
    return `/tasks?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>

      <TaskFilterBar
        basePath="/tasks"
        initialStart={customRange ? rawStart : undefined}
        initialEnd={customRange ? rawEnd : undefined}
        initialQ={filters.q}
        initialRepo={filters.repoId}
        initialPriority={filters.priority}
        initialStatus={filters.status}
        repos={repos}
      />

      {pageRows.length === 0 ? (
        <p className="text-xs text-muted">No tasks match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <TaskTable rows={pageRows} sort={sort} dir={dir} now={currentTimeMs()} searchPrefix={searchPrefix} />
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          Page {clampedPage} of {totalPages} — {rows.length} task{rows.length === 1 ? "" : "s"}
        </span>
        <div className="flex gap-3">
          {clampedPage > 1 ? (
            <Link href={pageHref(clampedPage - 1)} className="text-accent hover:underline">
              Previous
            </Link>
          ) : null}
          {clampedPage < totalPages ? (
            <Link href={pageHref(clampedPage + 1)} className="text-accent hover:underline">
              Next
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
