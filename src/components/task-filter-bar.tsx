"use client";

import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input, Select } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRIORITIES, TASK_STATUSES } from "@/server/pipeline/stages";

/**
 * S2/S3 — the board's date-range filter, above `TaskBoard` in `page.tsx`, now
 * joined by S2's structured filters (`?q=`, `?repo=`, `?priority=`,
 * `?status=`).
 *
 * `initialStart`/`initialEnd`/etc. come from `page.tsx`'s `searchParams`
 * (already validated server-side) — this component itself drives navigation
 * via `router.push`, never `useSearchParams()`, so it doesn't need a
 * `<Suspense>` boundary. That also means it only ever reflects a *new*
 * applied filter set after `page.tsx` re-renders with the pushed query
 * string, which is what makes "a full reload always shows the default"
 * true for free — there is nowhere client state could persist a filter
 * across a reload.
 *
 * Two independent single-date calendars (rather than one `mode="range"`
 * calendar) so a start date after the end date is a state a user can
 * actually reach — `mode="range"` selection in `react-day-picker` re-orders
 * the two clicks itself, which would make "end before start is rejected"
 * unreachable through the UI.
 */

/** `YYYY-MM-DD`, used both in the query string and as the calendar's `selected` value. */
function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function TaskFilterBar({
  initialStart,
  initialEnd,
  initialQ,
  initialRepo,
  initialPriority,
  initialStatus,
  repos,
  basePath = "/",
}: {
  initialStart?: string;
  initialEnd?: string;
  initialQ?: string;
  initialRepo?: string;
  initialPriority?: string;
  initialStatus?: string;
  repos: Array<{ id: string; name: string }>;
  /** S9: the list view (`/tasks`) shares this component against its own URL. */
  basePath?: string;
}) {
  const router = useRouter();
  const applied = initialStart && initialEnd ? { start: initialStart, end: initialEnd } : null;

  const [start, setStart] = useState<Date | undefined>(
    initialStart ? fromDateKey(initialStart) : undefined,
  );
  const [end, setEnd] = useState<Date | undefined>(initialEnd ? fromDateKey(initialEnd) : undefined);
  const [q, setQ] = useState(initialQ ?? "");
  const [repo, setRepo] = useState(initialRepo ?? "");
  const [priority, setPriority] = useState(initialPriority ?? "");
  const [status, setStatus] = useState(initialStatus ?? "");
  const [error, setError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  function structuredParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (repo) params.set("repo", repo);
    if (priority) params.set("priority", priority);
    if (status) params.set("status", status);
    return params;
  }

  function onApply() {
    if ((start && !end) || (!start && end)) {
      setError("Pick both a start and an end date, or neither.");
      return;
    }
    if (start && end && end.getTime() < start.getTime()) {
      setError("End date can't be before the start date.");
      return;
    }
    setError(null);

    const params = structuredParams();
    if (start && end) {
      params.set("start", toDateKey(start));
      params.set("end", toDateKey(end));
    } else {
      // No date range chosen: S2's explicit "everything" state, distinct
      // from the no-params default — see `lib/task-filter.ts`'s
      // `DateRangeFilter`.
      params.set("range", "all");
    }
    router.push(`${basePath}?${params.toString()}`);
  }

  function onReset() {
    setError(null);
    setStart(undefined);
    setEnd(undefined);
    setQ("");
    setRepo("");
    setPriority("");
    setStatus("");
    // "Everything" — every status, every date — not the no-params default
    // (today + open tasks). See `lib/task-filter.ts`'s `DateRangeFilter`.
    router.push(`${basePath}?range=all`);
  }

  const hasStructuredFilter = Boolean(q || repo || priority || status);

  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Search</span>
          <Input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Title or description"
            aria-label="Search title or description"
            className="h-8 w-44 text-xs"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Repository</span>
          <Select
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            aria-label="Filter by repository"
            className="h-8 w-36 py-1 text-xs"
          >
            <option value="">Any</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Priority</span>
          <Select
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            aria-label="Filter by priority"
            className="h-8 w-28 py-1 text-xs"
          >
            <option value="">Any</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Status</span>
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
            className="h-8 w-32 py-1 text-xs"
          >
            <option value="">Any</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Start date</span>
          <Popover open={startOpen} onOpenChange={setStartOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="secondary" size="sm" aria-label="Start date">
                {start ? format(start, "MMM d, yyyy") : "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={start}
                onSelect={(date) => {
                  setStart(date);
                  setStartOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">End date</span>
          <Popover open={endOpen} onOpenChange={setEndOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="secondary" size="sm" aria-label="End date">
                {end ? format(end, "MMM d, yyyy") : "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={end}
                onSelect={(date) => {
                  setEnd(date);
                  setEndOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        <Button type="button" size="sm" onClick={onApply}>
          Apply
        </Button>

        {applied || hasStructuredFilter ? (
          <Button type="button" size="sm" variant="ghost" onClick={onReset}>
            Reset
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : applied ? (
          <p className="text-xs text-muted">
            Showing {format(fromDateKey(applied.start), "MMM d")} –{" "}
            {format(fromDateKey(applied.end), "MMM d, yyyy")}
          </p>
        ) : (
          <p className="text-xs text-muted">Showing today&apos;s and open tasks</p>
        )}
      </div>
    </div>
  );
}
