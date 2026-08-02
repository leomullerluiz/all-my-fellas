import Link from "next/link";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCost, formatDateTime, formatTokens } from "@/lib/utils";
import { STAGE_LABELS } from "@/server/pipeline/stages";
import { costPerTask, usageByStage } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

export default async function UsagePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const rawDays = Array.isArray(search.days) ? search.days[0] : search.days;
  const parsedDays = rawDays ? Number.parseInt(rawDays, 10) : Number.NaN;
  const days = Number.isFinite(parsedDays) ? parsedDays : undefined;

  const byStage = usageByStage();
  const byTask = costPerTask(days);

  const total = byTask.reduce((sum, row) => sum + row.costUsd, 0);
  const maxStageCost = Math.max(1e-9, ...byStage.map((row) => row.costUsd));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Costs</h1>
          <p className="mt-1 text-xs text-muted">
            {formatCost(total)} across {byTask.length} task{byTask.length === 1 ? "" : "s"}
            {days ? ` in the last ${days} days` : " (all time)"}.
          </p>
        </div>
        <nav className="flex items-center gap-1 text-xs">
          <Link
            href="/usage"
            className={`rounded-md px-2.5 py-1 ${
              days ? "text-muted hover:bg-surface-raised" : "bg-surface-raised font-medium"
            }`}
          >
            All time
          </Link>
          {WINDOWS.map((window) => (
            <Link
              key={window.days}
              href={`/usage?days=${window.days}`}
              className={`rounded-md px-2.5 py-1 ${
                days === window.days
                  ? "bg-surface-raised font-medium"
                  : "text-muted hover:bg-surface-raised"
              }`}
            >
              {window.label}
            </Link>
          ))}
        </nav>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By stage (all time)</CardTitle>
        </CardHeader>
        <CardBody>
          {byStage.length === 0 ? (
            <p className="text-xs text-muted">No stage has run yet.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {byStage
                .slice()
                .sort((a, b) => b.costUsd - a.costUsd)
                .map((row) => (
                  <li key={row.stage} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-medium">{STAGE_LABELS[row.stage]}</span>
                      <span className="text-muted">
                        {row.runs} run{row.runs === 1 ? "" : "s"} ·{" "}
                        {formatTokens(row.inputTokens)} in / {formatTokens(row.outputTokens)} out
                        · {formatCost(row.costUsd)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.max(2, (row.costUsd / maxStageCost) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By task</CardTitle>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {byTask.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted">Nothing in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Task</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 text-right font-medium">Input</th>
                    <th className="px-4 py-2 text-right font-medium">Output</th>
                    <th className="px-4 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {byTask.map((row) => (
                    <tr key={row.taskId}>
                      <td className="max-w-xs truncate px-4 py-2">
                        <Link
                          href={`/tasks/${row.taskId}`}
                          className="hover:text-accent hover:underline"
                        >
                          {row.title}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-muted">{row.status}</td>
                      <td className="px-4 py-2 text-muted">{formatDateTime(row.createdAt)}</td>
                      <td className="px-4 py-2 text-right text-muted">
                        {formatTokens(row.inputTokens)}
                      </td>
                      <td className="px-4 py-2 text-right text-muted">
                        {formatTokens(row.outputTokens)}
                      </td>
                      <td className="px-4 py-2 text-right">{formatCost(row.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
