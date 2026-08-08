"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DiffFile, DiffIndex } from "@/server/git/diff";
import type { ParsedDiffSummary } from "@/server/pipeline/diff-summary";

/**
 * Unified diff viewer.
 *
 * Diff content is untrusted repository text. It is rendered as React children
 * so it is escaped — **never** introduce `dangerouslySetInnerHTML` here. A
 * syntax highlighter that returns an HTML string would turn a malicious
 * repository into stored XSS against this dashboard; one that returns React
 * elements is fine.
 */

type IndexResponse =
  | ({ available: true } & DiffIndex)
  | { available: false; reason: string; prUrl: string | null; summary: ParsedDiffSummary | null };

type PatchResponse = {
  available: true;
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
};

const STATUS_TONE = {
  added: "success",
  modified: "info",
  deleted: "danger",
  renamed: "warning",
} as const;

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

/** Truncates in the middle so the filename — the useful part — survives. */
function shortenPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.length >= max - 3) return `…${name.slice(-(max - 1))}`;
  return `${path.slice(0, max - name.length - 4)}…/${name}`;
}

type LineKind = "add" | "remove" | "context" | "hunk" | "meta";

function classifyLine(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

const LINE_STYLE: Record<LineKind, string> = {
  add: "bg-success/10 text-foreground",
  remove: "bg-danger/10 text-foreground",
  context: "text-muted",
  hunk: "bg-border/40 text-info",
  meta: "text-muted/60",
};

const LINE_LABEL: Record<LineKind, string> = {
  add: "added line",
  remove: "removed line",
  context: "unchanged line",
  hunk: "hunk header",
  meta: "diff header",
};

/**
 * Renders one unified-diff patch as a gutter-marked table.
 *
 * Exported so the artifact version switcher's compare view (§7) can render a
 * synthetic patch through the same no-raw-HTML renderer instead of a second
 * diff library.
 */
export function PatchBody({ patch }: { patch: string }) {
  const lines = patch.split("\n");

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[11px] leading-relaxed">
        <tbody>
          {lines.map((line, index) => {
            const kind = classifyLine(line);
            return (
              <tr key={index} className={LINE_STYLE[kind]}>
                {/* The +/- marker stays in its own cell so the diff is readable
                    without relying on colour alone. */}
                <td
                  aria-hidden
                  className="w-6 select-none border-r border-border/60 px-1.5 text-center text-muted/70"
                >
                  {kind === "add" ? "+" : kind === "remove" ? "−" : ""}
                </td>
                <td className="whitespace-pre-wrap break-words px-2">
                  <span className="sr-only">{LINE_LABEL[kind]}: </span>
                  {kind === "add" || kind === "remove" ? line.slice(1) : line}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DiffViewer({ taskId }: { taskId: string }) {
  const [index, setIndex] = useState<IndexResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<PatchResponse | null>(null);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPatch = useCallback(
    async (path: string) => {
      setSelected(path);
      setLoadingPatch(true);
      setPatch(null);
      try {
        const response = await fetch(
          `/api/tasks/${taskId}/diff?file=${encodeURIComponent(path)}`,
        );
        const payload = (await response.json()) as PatchResponse & { error?: string };
        if (!response.ok) {
          setError(payload.error ?? "Could not read that file.");
        } else {
          setPatch(payload);
        }
      } catch {
        setError("Could not reach the server.");
      }
      setLoadingPatch(false);
    },
    [taskId],
  );

  // Only the index is fetched on mount. The first file's patch is loaded from
  // inside this async callback, and every later one from the click handler —
  // watching `selected` with a second effect would set state synchronously in
  // an effect body and cause a cascading render for no benefit.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/diff`);
        const payload = (await response.json()) as IndexResponse & { error?: string };
        if (cancelled) return;

        if (!response.ok) {
          setError(payload.error ?? "Could not read the diff.");
          return;
        }
        setIndex(payload);
        if (payload.available && payload.files.length > 0) {
          await loadPatch(payload.files[0].path);
        }
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [taskId, loadPatch]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Diff</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-xs text-danger">{error}</p>
        </CardBody>
      </Card>
    );
  }

  if (!index) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Diff</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-xs text-muted">Reading the workspace…</p>
        </CardBody>
      </Card>
    );
  }

  if (!index.available) {
    const summary = index.summary;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Diff</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-xs text-muted">{index.reason}</p>
          {index.prUrl ? (
            <a
              href={index.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-accent underline-offset-2 hover:underline"
            >
              View the changes on the remote ↗
            </a>
          ) : null}
          {summary ? (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="text-[11px] text-muted">
                The workspace is gone, but a summary was persisted before delivery
                {summary.headCommitSha ? (
                  <>
                    {" "}
                    at commit <span className="font-mono">{summary.headCommitSha.slice(0, 12)}</span>
                  </>
                ) : null}
                :{" "}
                <span className="text-success">+{summary.totalAdditions}</span>{" "}
                <span className="text-danger">−{summary.totalDeletions}</span>
              </p>
              <ul className="max-h-[24rem] overflow-y-auto rounded-md border border-border">
                {summary.files.map((file) => (
                  <li
                    key={file.oldPath ? `${file.oldPath}->${file.path}` : file.path}
                    className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0"
                  >
                    <Badge tone={STATUS_TONE[file.status]}>{STATUS_LETTER[file.status]}</Badge>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px]"
                      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    >
                      {shortenPath(file.path)}
                    </span>
                    {file.binary ? (
                      <span className="shrink-0 text-[10px] text-muted">bin</span>
                    ) : (
                      <span className="shrink-0 text-[10px] tabular-nums">
                        <span className="text-success">+{file.additions}</span>{" "}
                        <span className="text-danger">−{file.deletions}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardBody>
      </Card>
    );
  }

  if (index.files.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Diff</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-xs text-muted">
            The task branch has no changes against origin/{index.baseBranch} yet.
          </p>
        </CardBody>
      </Card>
    );
  }

  const current: DiffFile | undefined = index.files.find((file) => file.path === selected);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Diff against origin/{index.baseBranch}</CardTitle>
        <span className="text-[11px] text-muted">
          {index.files.length} file{index.files.length === 1 ? "" : "s"} changed,{" "}
          <span className="text-success">+{index.totalAdditions}</span>{" "}
          <span className="text-danger">−{index.totalDeletions}</span>
          {index.truncated ? " · list capped at 500 files" : ""}
        </span>
      </CardHeader>

      <CardBody className="grid gap-4 p-0 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <nav
          aria-label="Changed files"
          className="max-h-[34rem] overflow-y-auto border-b border-border lg:border-b-0 lg:border-r"
        >
          <ul>
            {index.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => void loadPatch(file.path)}
                  aria-current={file.path === selected ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                    file.path === selected ? "bg-accent/10" : "hover:bg-border/30",
                  )}
                >
                  <Badge tone={STATUS_TONE[file.status]}>{STATUS_LETTER[file.status]}</Badge>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px]"
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  >
                    {shortenPath(file.path)}
                  </span>
                  {file.binary ? (
                    <span className="shrink-0 text-[10px] text-muted">bin</span>
                  ) : (
                    <span className="shrink-0 text-[10px] tabular-nums">
                      <span className="text-success">+{file.additions}</span>{" "}
                      <span className="text-danger">−{file.deletions}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 max-h-[34rem] overflow-y-auto p-3">
          {current?.oldPath ? (
            <p className="mb-2 font-mono text-[11px] text-muted">
              renamed from {current.oldPath}
            </p>
          ) : null}

          {loadingPatch ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : patch?.binary ? (
            <p className="text-xs text-muted">Binary file — no textual diff to show.</p>
          ) : patch ? (
            <>
              <PatchBody patch={patch.patch} />
              {patch.truncated ? (
                <p className="mt-2 text-[11px] text-warning">
                  This patch was truncated because the file is very large.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted">Select a file.</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
