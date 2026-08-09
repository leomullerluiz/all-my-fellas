"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { describe, toneFor } from "@/components/live-log";
import { cn } from "@/lib/utils";
import { PIPELINE_EVENT_TYPES, type PipelineEvent } from "@/server/events/types";

/**
 * S6 §6.3 — reverse-chronological, cross-task event feed at `/activity`.
 *
 * Initial paint comes from the server (`listRecentEvents`, passed in as
 * `initial`); live updates come from the *existing* global SSE route
 * (`/api/events/stream`) rather than a second stream implementation — the
 * same one `spec-spend-and-operational-control.md` §8.2 built for
 * notifications. This is deliberately the pull/read half of that one
 * capability.
 */
export type ActivityEntry = {
  id: number;
  taskId: string;
  taskTitle: string;
  createdAt: number;
  payload: PipelineEvent;
};

const MAX_ENTRIES = 300;

export function ActivityFeed({ initial }: { initial: ActivityEntry[] }) {
  const [entries, setEntries] = useState<ActivityEntry[]>(initial);
  const cursorRef = useRef(initial[0]?.id ?? 0);

  useEffect(() => {
    const source = new EventSource(`/api/events/stream?after=${cursorRef.current}`);

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as {
          id: number;
          taskId: string;
          createdAt: number;
          payload: PipelineEvent;
        };
        if (!parsed.payload) return;
        cursorRef.current = Math.max(cursorRef.current, parsed.id);
        setEntries((previous) =>
          [
            {
              id: parsed.id,
              taskId: parsed.taskId,
              // The stream doesn't carry the title; the row falls back to the
              // task id, which is still a working link.
              taskTitle: parsed.taskId,
              createdAt: parsed.createdAt,
              payload: parsed.payload,
            },
            ...previous,
          ].slice(0, MAX_ENTRIES),
        );
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };

    source.addEventListener("message", onMessage);
    for (const type of PIPELINE_EVENT_TYPES) {
      source.addEventListener(type, onMessage as EventListener);
    }

    return () => source.close();
  }, []);

  if (entries.length === 0) {
    return <p className="text-xs text-muted">Nothing has happened yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[11px] leading-relaxed">
      {entries.map((entry) => (
        <li key={entry.id} className={cn("whitespace-pre-wrap", toneFor(entry.payload))}>
          <span className="mr-2 text-muted/60">{new Date(entry.createdAt).toLocaleString()}</span>
          <Link href={`/tasks/${entry.taskId}`} className="mr-2 text-accent hover:underline">
            {entry.taskTitle}
          </Link>
          {describe(entry.payload)}
        </li>
      ))}
    </ul>
  );
}
