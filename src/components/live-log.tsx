"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PipelineEvent } from "@/server/events/store";

/**
 * Live agent log, fed by the task's SSE endpoint.
 *
 * Stage-level events also trigger a router refresh so the surrounding
 * server-rendered panels (timeline, artifacts, gate buttons) stay in step
 * without polling on their own.
 */

type LogLine = { seq: number; createdAt: number; payload: PipelineEvent };

/** Events that change server-rendered state and warrant a refresh. */
const REFRESH_TRIGGERS = new Set([
  "stage_started",
  "stage_finished",
  "stage_failed",
  "artifact_saved",
  "gate_opened",
  "gate_decided",
  "pr_opened",
  "task_finished",
]);

const MAX_LINES = 400;

function toneFor(event: PipelineEvent): string {
  switch (event.type) {
    case "stage_started":
      return "text-accent";
    case "stage_finished":
      return "text-success";
    case "stage_failed":
    case "agent_tool_denied":
      return "text-danger";
    case "gate_opened":
      return "text-warning";
    case "agent_tool_use":
      return "text-info";
    case "log":
      return event.level === "error"
        ? "text-danger"
        : event.level === "warn"
          ? "text-warning"
          : "text-muted";
    default:
      return "text-foreground";
  }
}

function describe(event: PipelineEvent): string {
  switch (event.type) {
    case "task_created":
      return `Task created: ${event.title}`;
    case "task_started":
      return "▶ Task started";
    case "task_edited":
      return `✎ Edited: ${event.fields.join(", ")}`;
    case "stage_started":
      return `▶ ${event.stage} started (attempt ${event.attempt}${
        event.model ? `, ${event.model}` : ""
      })`;
    case "stage_finished":
      return `✔ ${event.stage} finished`;
    case "stage_failed":
      return `✖ ${event.stage} failed: ${event.error}`;
    case "agent_text":
      return event.text;
    case "agent_thinking":
      return "…thinking";
    case "agent_tool_use":
      return `⚙ ${event.tool} ${event.summary}`;
    case "agent_tool_denied":
      return `⛔ ${event.tool} blocked: ${event.reason}`;
    case "artifact_saved":
      return `📄 saved ${event.artifactType}`;
    case "gate_opened":
      return `⏸ waiting for approval at ${event.gate}`;
    case "gate_decided":
      return `${event.decision === "approve" ? "✔" : "✖"} ${event.gate}: ${event.decision}${
        event.comment ? ` — ${event.comment}` : ""
      }`;
    case "git":
      return `git: ${event.message}`;
    case "pr_opened":
      return `🔗 pull request opened: ${event.url}`;
    case "task_finished":
      return `■ task finished (${event.stage})${event.reason ? `: ${event.reason}` : ""}`;
    case "log":
      return event.message;
  }
}

export function LiveLog({ taskId, live }: { taskId: string; live: boolean }) {
  const router = useRouter();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const source = new EventSource(`/api/tasks/${taskId}/stream`);

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as LogLine;
        if (!parsed.payload) return;
        setLines((previous) => [...previous, parsed].slice(-MAX_LINES));
        if (REFRESH_TRIGGERS.has(parsed.payload.type)) router.refresh();
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    // Every payload is dispatched under its own event name, so a single
    // `message` handler is not enough — listen on the element instead.
    source.addEventListener("message", onMessage);
    for (const type of [
      "task_created",
      "stage_started",
      "stage_finished",
      "stage_failed",
      "agent_text",
      "agent_thinking",
      "agent_tool_use",
      "agent_tool_denied",
      "artifact_saved",
      "gate_opened",
      "gate_decided",
      "git",
      "pr_opened",
      "task_finished",
      "log",
    ]) {
      source.addEventListener(type, onMessage as EventListener);
    }
    source.addEventListener("done", () => {
      setConnected(false);
      source.close();
      router.refresh();
    });

    return () => source.close();
  }, [taskId, router]);

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, follow]);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Agent log</CardTitle>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            Follow
          </label>
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                connected ? "bg-success" : live ? "bg-warning" : "bg-muted",
              )}
            />
            {connected ? "connected" : live ? "reconnecting" : "closed"}
          </span>
        </div>
      </CardHeader>
      <CardBody>
        <div className="max-h-[28rem] overflow-auto rounded-md border border-border bg-background p-3">
          {lines.length === 0 ? (
            <p className="text-xs text-muted">Waiting for the worker…</p>
          ) : (
            <ul className="flex flex-col gap-0.5 font-mono text-[11px] leading-relaxed">
              {lines.map((line) => (
                <li key={line.seq} className={cn("whitespace-pre-wrap", toneFor(line.payload))}>
                  <span className="mr-2 text-muted/60">
                    {new Date(line.createdAt).toLocaleTimeString()}
                  </span>
                  {describe(line.payload)}
                </li>
              ))}
            </ul>
          )}
          <div ref={bottomRef} />
        </div>
      </CardBody>
    </Card>
  );
}
