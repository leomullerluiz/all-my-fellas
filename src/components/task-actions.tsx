"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import type { Gate, TaskStatus } from "@/server/pipeline/stages";

/** Human gate approval plus the retry / cancel controls. */

const GATE_COPY: Record<Gate, { title: string; description: string; approve: string }> = {
  PLAN_GATE: {
    title: "Approve the technical plan",
    description:
      "The Architect has produced techplan.md with an approach, affected files and an estimate. Approving hands it to the Developer.",
    approve: "Approve plan",
  },
  STAKEHOLDER_GATE: {
    title: "Approve delivery",
    description:
      "QA and homologation are done. Approving pushes the branch and opens a pull request — the merge still happens on GitHub.",
    approve: "Approve and deliver",
  },
};

export function GatePanel({ taskId, gate }: { taskId: string; gate: Gate }) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = GATE_COPY[gate];

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);

    const response = await fetch(`/api/tasks/${taskId}/gates/${gate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not record the decision.");
      setBusy(null);
      return;
    }

    setBusy(null);
    setComment("");
    router.refresh();
  }

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="text-warning">{copy.title}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-xs text-muted">{copy.description}</p>
        <Textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={3}
          placeholder="Optional comment, recorded with the decision"
          aria-label="Decision comment"
        />
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="success" disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" ? "Recording…" : copy.approve}
          </Button>
          <Button variant="danger" disabled={busy !== null} onClick={() => decide("reject")}>
            {busy === "reject" ? "Recording…" : "Reject"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Detail-page controls.
 *
 * A not-yet-started task gets Start / Edit / Delete and deliberately no Cancel:
 * cancelling from `CREATED` produces a terminal `CANCELLED` row that can never
 * be started, edited or removed — see `spec-task-queue.md` §10.
 */
export function TaskControls({
  taskId,
  taskTitle,
  status,
  notStarted,
  capacity,
}: {
  taskId: string;
  taskTitle: string;
  status: TaskStatus;
  notStarted: boolean;
  capacity: { slotAvailable: boolean; limit: number; blocking: Array<{ title: string }> };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canCancel = !notStarted && ["running", "awaiting_gate"].includes(status);
  const canRetry = status === "failed";

  const blockedReason = capacity.slotAvailable
    ? null
    : `Limit of ${capacity.limit} task${capacity.limit === 1 ? "" : "s"} in progress reached` +
      (capacity.blocking[0] ? ` — ${capacity.blocking[0].title} is still running.` : ".");

  async function call(action: string, url: string, method = "POST") {
    setBusy(action);
    setError(null);

    const response = await fetch(url, { method });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? `Could not ${action} the task.`);
      setBusy(null);
      return;
    }

    setBusy(null);
    if (action === "delete") {
      router.push("/");
    }
    router.refresh();
  }

  function onDelete() {
    const confirmed = window.confirm(
      `Delete "${taskTitle}"? This removes the task permanently and cannot be undone.`,
    );
    if (confirmed) void call("delete", `/api/tasks/${taskId}`, "DELETE");
  }

  if (notStarted) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy !== null || !capacity.slotAvailable}
          title={blockedReason ?? undefined}
          onClick={() => call("start", `/api/tasks/${taskId}/start`)}
        >
          {busy === "start" ? "Starting…" : "Start"}
        </Button>
        <Link href={`/tasks/${taskId}/edit`}>
          <Button variant="secondary" size="sm">
            Edit
          </Button>
        </Link>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onDelete}>
          {busy === "delete" ? "Deleting…" : "Delete"}
        </Button>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
        {!error && blockedReason ? (
          <span className="text-xs text-muted">{blockedReason}</span>
        ) : null}
      </div>
    );
  }

  if (!canCancel && !canRetry) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canRetry ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null || !capacity.slotAvailable}
          title={blockedReason ?? undefined}
          onClick={() => call("retry", `/api/tasks/${taskId}/retry`)}
        >
          {busy === "retry" ? "Retrying…" : "Retry failed stage"}
        </Button>
      ) : null}
      {canCancel ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => call("cancel", `/api/tasks/${taskId}/cancel`)}
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel task"}
        </Button>
      ) : null}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
