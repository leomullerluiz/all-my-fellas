"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { NEUTRAL_CHANGE_REQUEST_NOUN } from "@/lib/provider-copy";
import { cn } from "@/lib/utils";
// From `./types`, not `./store`: `store.ts` imports the SQLite client, which
// cannot be bundled for the browser. `./types` has no server-only imports at
// all — see its header comment.
import { PIPELINE_EVENT_TYPES, type PipelineEvent } from "@/server/events/types";

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
  "gate_bypassed",
  "pr_opened",
  "task_finished",
  // Changes the timeline (a new stage run) and the gate badge computed from
  // `verification_runs`, both server-rendered.
  "verification_finished",
]);

const MAX_LINES = 400;

/**
 * Exported for `tests/live-log-tone.test.tsx` — the `default` branch means a
 * missed case here compiles cleanly (unlike `describe()` below, which has no
 * `default` and is therefore compiler-forced), so the failed/errored/stderr
 * branches need a direct test rather than relying on totality.
 */
export function toneFor(event: PipelineEvent): string {
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
    // Flags a safety checkpoint that was skipped, not just opened — distinct
    // from `gate_opened`'s warning tone.
    case "gate_bypassed":
      return "text-danger";
    case "agent_tool_use":
      return "text-info";
    case "log":
      return event.level === "error"
        ? "text-danger"
        : event.level === "warn"
          ? "text-warning"
          : "text-muted";
    // Not compiler-forced — `default` below still covers every other
    // variant — but red verification is exactly the signal this stage
    // exists to make visible, so it gets an explicit branch rather than
    // silently inheriting the neutral default.
    case "verification_finished":
      return event.status === "failed" || event.status === "errored"
        ? "text-danger"
        : event.status === "skipped"
          ? "text-warning"
          : "text-success";
    // `stream` is carried precisely so stderr can be told apart from stdout
    // in the log (§7) — a command's failure output is usually on stderr.
    case "verification_output":
      return event.stream === "stderr" ? "text-warning" : "text-foreground";
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
        event.provider ? `, ${event.provider}` : ""
      }${event.model ? `, ${event.model}` : ""})`;
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
    case "gate_bypassed":
      return `⚠ ${event.gate} bypassed — no-approval automation is enabled`;
    case "gate_decided":
      return `${event.decision === "approve" ? "✔" : "✖"} ${event.gate}: ${event.decision}${
        event.comment ? ` — ${event.comment}` : ""
      }`;
    case "git":
      return `git: ${event.message}`;
    case "pr_opened":
      // `noun` is absent on events written before the field existed.
      return `🔗 ${event.noun ?? NEUTRAL_CHANGE_REQUEST_NOUN} opened: ${event.url}`;
    case "task_finished":
      return `■ task finished (${event.stage})${event.reason ? `: ${event.reason}` : ""}`;
    case "log":
      return event.message;
    case "verification_started":
      return `▶ verification started (${event.commands.join(", ") || "no commands"})`;
    case "verification_command_started":
      return `▶ ${event.kind}: ${event.command}`;
    case "verification_output":
      return event.chunk;
    case "verification_command_finished":
      return `${event.exitCode === 0 ? "✔" : "✖"} ${event.kind} ${
        event.timedOut ? "timed out" : `exited ${event.exitCode ?? "null"}`
      } (${Math.round(event.durationMs / 1000)}s)`;
    case "verification_finished":
      return `■ verification ${event.status}${event.reason ? `: ${event.reason}` : ""}`;
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
    for (const type of PIPELINE_EVENT_TYPES) {
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
