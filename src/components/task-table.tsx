import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatCost, formatRelativeAge } from "@/lib/utils";
import { STAGE_LABELS } from "@/server/pipeline/stages";

/** One row of `/tasks`' list view (S9 §4.5). */
export type TaskTableRow = {
  id: string;
  title: string;
  repoName: string;
  stage: keyof typeof STAGE_LABELS;
  status: string;
  createdAt: number;
  costUsd: number;
};

export const SORT_KEYS = ["title", "repo", "status", "age", "cost"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

function sortLink(key: SortKey, currentSort: SortKey, currentDir: "asc" | "desc", basePath: string) {
  const nextDir = currentSort === key && currentDir === "asc" ? "desc" : "asc";
  const url = new URL(basePath, "http://internal");
  url.searchParams.set("sort", key);
  url.searchParams.set("dir", nextDir);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "title", label: "Title" },
  { key: "repo", label: "Repository" },
  { key: "status", label: "Status" },
  { key: "age", label: "Age" },
  { key: "cost", label: "Cost" },
];

export function TaskTable({
  rows,
  sort,
  dir,
  now,
  searchPrefix,
}: {
  rows: TaskTableRow[];
  sort: SortKey;
  dir: "asc" | "desc";
  now: number;
  /** The current query string (minus `sort`/`dir`), so sort links preserve every other filter. */
  searchPrefix: string;
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
          {COLUMNS.map((column) => (
            <th key={column.key} className="px-2 py-2 font-semibold">
              <Link
                href={sortLink(column.key, sort, dir, `/tasks?${searchPrefix}`)}
                className="hover:text-foreground"
              >
                {column.label}
                {sort === column.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
              </Link>
            </th>
          ))}
          <th className="px-2 py-2 font-semibold">Stage</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-border/60 hover:bg-surface-raised">
            <td className="px-2 py-1.5">
              <Link href={`/tasks/${row.id}`} className="text-accent hover:underline">
                {row.title}
              </Link>
            </td>
            <td className="px-2 py-1.5 text-muted">{row.repoName}</td>
            <td className="px-2 py-1.5">
              <Badge tone="neutral">{row.status}</Badge>
            </td>
            <td className="px-2 py-1.5 tabular-nums text-muted">{formatRelativeAge(now - row.createdAt)} ago</td>
            <td className="px-2 py-1.5 tabular-nums text-muted">{formatCost(row.costUsd)}</td>
            <td className="px-2 py-1.5 text-muted">{STAGE_LABELS[row.stage]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
