"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";

/**
 * Renders a stage run's normalised transcript (`normalizeTranscript`, see
 * `src/server/pipeline/audit/normalize.ts`).
 *
 * A transcript contains verbatim repository file contents — untrusted text,
 * exactly the situation `diff-viewer.tsx` guards against. Every entry is
 * rendered as React children so it is escaped: **never** introduce
 * `dangerouslySetInnerHTML` or `innerHTML` here.
 */

type TranscriptEntry = {
  index: number;
  role: "system" | "assistant" | "tool" | "user" | "result";
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "meta" | "result";
  text?: string;
  tool?: { name: string; input?: unknown; output?: string; isError?: boolean };
  usage?: { inputTokens: number; outputTokens: number };
  unrecognised?: true;
};

type TranscriptPage =
  | { available: false; reason: "pruned"; prunedAt: number }
  | { available: false; reason: "no_transcript" }
  | {
      available: true;
      provider: string;
      truncated: boolean;
      total: number;
      offset: number;
      limit: number;
      entries: TranscriptEntry[];
    };

const ROLE_TONE: Record<TranscriptEntry["role"], "neutral" | "accent" | "info" | "warning"> = {
  system: "neutral",
  assistant: "accent",
  tool: "info",
  user: "neutral",
  result: "warning",
};

/** Collapses long bodies behind a `<details>` so a big tool result does not dominate the page. */
function CollapsibleBody({ text, lineThreshold, isError }: { text: string; lineThreshold: number; isError?: boolean }) {
  const lines = text.split("\n");
  const long = lines.length > lineThreshold;

  const body = (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-relaxed ${
        isError ? "border-danger/40 bg-danger/10 text-danger" : "border-border bg-surface-raised text-foreground"
      }`}
    >
      {text}
    </pre>
  );

  if (!long) return body;

  return (
    <details>
      <summary className="cursor-pointer text-[11px] text-muted">
        {lines.length} lines — click to expand
      </summary>
      <div className="mt-1">{body}</div>
    </details>
  );
}

function EntryCard({ entry }: { entry: TranscriptEntry }) {
  return (
    <li className="flex flex-col gap-1 rounded border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ROLE_TONE[entry.role]}>{entry.role}</Badge>
        <span className="text-[11px] text-muted">{entry.kind}</span>
        {entry.tool ? <span className="text-[11px] font-medium">{entry.tool.name}</span> : null}
        {entry.unrecognised ? <Badge tone="warning">unrecognised</Badge> : null}
        {entry.usage ? (
          <span className="text-[11px] text-muted">
            {entry.usage.inputTokens} in / {entry.usage.outputTokens} out
          </span>
        ) : null}
      </div>

      {entry.kind === "thinking" && entry.text ? (
        <p className="text-[11px] italic text-muted">{entry.text}</p>
      ) : entry.text ? (
        <CollapsibleBody text={entry.text} lineThreshold={40} />
      ) : null}

      {entry.tool && entry.tool.input !== undefined ? (
        <div>
          <p className="text-[11px] text-muted">input</p>
          <CollapsibleBody text={JSON.stringify(entry.tool.input, null, 2)} lineThreshold={20} />
        </div>
      ) : null}

      {entry.tool && entry.tool.output !== undefined ? (
        <div>
          <p className="text-[11px] text-muted">output</p>
          <CollapsibleBody text={entry.tool.output} lineThreshold={40} isError={entry.tool.isError} />
        </div>
      ) : null}
    </li>
  );
}

export function TranscriptViewer({ taskId, runId }: { taskId: string; runId: string }) {
  const [page, setPage] = useState<TranscriptPage | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      try {
        const response = await fetch(
          `/api/tasks/${taskId}/runs/${runId}/transcript?offset=${offset}&limit=50`,
        );
        const payload = (await response.json()) as { transcript: TranscriptPage; error?: string };
        if (!response.ok) {
          setError(payload.error ?? "Could not load the transcript.");
          return;
        }
        const transcript = payload.transcript;
        setPage(transcript);
        if (transcript.available) {
          const nextEntries = transcript.entries;
          setEntries((previous) => (offset === 0 ? nextEntries : [...previous, ...nextEntries]));
        }
      } catch {
        setError("Could not reach the server.");
      }
    },
    [taskId, runId],
  );

  useEffect(() => {
    void (async () => {
      await load(0);
    })();
  }, [load]);

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!page) return <p className="text-xs text-muted">Loading transcript…</p>;

  if (!page.available) {
    return (
      <p className="text-xs text-muted">
        {page.reason === "pruned"
          ? `Transcript pruned on ${new Date(page.prunedAt).toLocaleString()}.`
          : "No transcript was recorded for this run."}
      </p>
    );
  }

  const hasMore = page.offset + page.entries.length < page.total;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted">
        {page.total} entries · provider: {page.provider}
        {page.truncated ? " · truncated" : ""}
      </p>
      <ol className="flex flex-col gap-2">
        {entries.map((entry) => (
          <EntryCard key={entry.index} entry={entry} />
        ))}
      </ol>
      {hasMore ? (
        <button
          type="button"
          className="self-start rounded border border-border px-3 py-1 text-xs hover:bg-surface-raised"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            await load(entries.length);
            setLoadingMore(false);
          }}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
