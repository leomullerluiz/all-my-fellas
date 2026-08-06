"use client";

import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * S2/S3 — the board's date-range filter, above `TaskBoard` in `page.tsx`.
 *
 * `initialStart`/`initialEnd` come from `page.tsx`'s `searchParams` (already
 * validated server-side by `parseDateRangeParams`) — this component itself
 * drives navigation via `router.push`, never `useSearchParams()`, so it
 * doesn't need a `<Suspense>` boundary. That also means it only ever reflects
 * a *new* applied range after `page.tsx` re-renders with the pushed query
 * string, which is what makes "a full reload always shows the default"
 * (S3) true for free — there is nowhere client state could persist a range
 * across a reload.
 *
 * Two independent single-date calendars (rather than one `mode="range"`
 * calendar) so a start date after the end date is a state a user can
 * actually reach — `mode="range"` selection in `react-day-picker` re-orders
 * the two clicks itself, which would make S2's "end before start is
 * rejected" acceptance criterion unreachable through the UI.
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
}: {
  initialStart?: string;
  initialEnd?: string;
}) {
  const router = useRouter();
  const applied = initialStart && initialEnd ? { start: initialStart, end: initialEnd } : null;

  const [start, setStart] = useState<Date | undefined>(
    initialStart ? fromDateKey(initialStart) : undefined,
  );
  const [end, setEnd] = useState<Date | undefined>(initialEnd ? fromDateKey(initialEnd) : undefined);
  const [error, setError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  function onApply() {
    if (!start || !end) {
      setError("Pick both a start and an end date.");
      return;
    }
    if (end.getTime() < start.getTime()) {
      setError("End date can't be before the start date.");
      return;
    }
    setError(null);
    router.push(`/?start=${toDateKey(start)}&end=${toDateKey(end)}`);
  }

  function onReset() {
    setError(null);
    setStart(undefined);
    setEnd(undefined);
    router.push("/");
  }

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
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

      {applied ? (
        <Button type="button" size="sm" variant="ghost" onClick={onReset}>
          Reset
        </Button>
      ) : null}

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
