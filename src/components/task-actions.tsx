"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import { capacityBlockedReason } from "@/lib/capacity";
import { dependencyBlockedReason } from "@/lib/dependencies";
import { GATE_ALLOWED_DECISIONS, type Gate, type TaskStatus } from "@/server/pipeline/stages";

/** Human gate approval plus the retry / cancel controls. */

const GATE_COPY: Record<
  Gate,
  { title: string; description: string; approve: string; approvedToast: string }
> = {
  PLAN_GATE: {
    title: "Approve the technical plan",
    description:
      "The Architect has produced techplan.md with an approach, affected files and an estimate. Approving hands it to the Developer.",
    approve: "Approve plan",
    approvedToast: "Plan approved",
  },
  HUMAN_CODE_REVIEW: {
    title: "Review the code",
    description:
      "Code review and QA have passed. Read the diff before this ships. Requesting changes sends the work back to the Developer with your comment.",
    approve: "Approve code",
    approvedToast: "Code approved",
  },
  STAKEHOLDER_GATE: {
    title: "Approve delivery",
    description:
      "QA and homologation are done. Approving pushes the branch and opens a pull request — the merge still happens on GitHub.",
    approve: "Approve and deliver",
    approvedToast: "Delivery approved",
  },
};

type Decision = "approve" | "request_changes" | "reject";

/** Everything but "approve" reads the same across gates. */
const DECISION_TOAST: Record<Exclude<Decision, "approve">, string> = {
  request_changes: "Changes requested",
  reject: "Task rejected",
};

export function GatePanel({
  taskId,
  gate,
  diffSummary,
}: {
  taskId: string;
  gate: Gate;
  /** e.g. "14 files changed, +320 −87" — shown so the size is visible up front. */
  diffSummary?: string | null;
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  // Pre-submission field validation only (empty comment on "Request changes")
  // — the request outcome itself is reported via toast, not this state.
  const [commentError, setCommentError] = useState<string | null>(null);

  const copy = GATE_COPY[gate];
  const allowed = GATE_ALLOWED_DECISIONS[gate];
  const canRequestChanges = allowed.includes("request_changes");

  async function decide(decision: Decision) {
    const trimmed = comment.trim();
    // Enforced server-side too; catching it here saves a round trip and keeps
    // the reviewer's text in the box.
    if (decision === "request_changes" && trimmed === "") {
      setCommentError("Say what needs to change — the Developer only sees this comment.");
      return;
    }

    setBusy(decision);
    setCommentError(null);

    const response = await fetch(`/api/tasks/${taskId}/gates/${gate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, comment: trimmed || undefined }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(payload.error ?? "Could not record the decision.");
      setBusy(null);
      return;
    }

    toast.success(decision === "approve" ? copy.approvedToast : DECISION_TOAST[decision]);
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

        {gate === "HUMAN_CODE_REVIEW" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/tasks/${taskId}/review`}
              className="text-xs font-medium text-accent underline-offset-2 hover:underline"
            >
              Open the diff viewer →
            </Link>
            {diffSummary ? <span className="text-xs text-muted">{diffSummary}</span> : null}
          </div>
        ) : null}

        <Textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={3}
          placeholder={
            canRequestChanges
              ? "Required when requesting changes — this is all the Developer sees"
              : "Optional comment, recorded with the decision"
          }
          aria-label="Decision comment"
        />
        {commentError ? <p className="text-xs text-danger">{commentError}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="success" disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" ? "Recording…" : copy.approve}
          </Button>
          {canRequestChanges ? (
            <Button
              disabled={busy !== null}
              onClick={() => decide("request_changes")}
            >
              {busy === "request_changes" ? "Recording…" : "Request changes"}
            </Button>
          ) : null}
          <Button variant="danger" disabled={busy !== null} onClick={() => decide("reject")}>
            {busy === "reject" ? "Recording…" : "Reject"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

const ACTION_SUCCESS_TOAST: Record<string, string> = {
  start: "Task started.",
  cancel: "Task cancelled.",
  retry: "Retrying the failed stage.",
  delete: "Task deleted.",
};

/**
 * Detail-page controls.
 *
 * A not-yet-started task gets Start / Edit / Delete and deliberately no Cancel:
 * cancelling from `CREATED` produces a terminal `CANCELLED` row that can never
 * be started, edited or removed — see `spec-task-queue.md` §10.
 *
 * The exceptions are `on_queue` and `gate_queued`: a task parked at either
 * has already committed to running, so — per S3, and the approval-queue
 * equivalent for gate resumes — it also gets Cancel, the same as an
 * in-flight task. Removing it that way is what lets the rest of the queue
 * keep advancing (`promoteQueue` re-reads both queue lists on the next
 * slot-freeing transition, unaffected by the removal).
 */
export function TaskControls({
  taskId,
  taskTitle,
  status,
  notStarted,
  capacity,
  dependsOn = [],
}: {
  taskId: string;
  taskTitle: string;
  status: TaskStatus;
  notStarted: boolean;
  capacity: { slotAvailable: boolean; limit: number; blocking: Array<{ title: string }> };
  /** This task's prerequisites, so Start can be disabled independently of capacity. */
  dependsOn?: Array<{ title: string; status: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const canCancel = ["running", "awaiting_gate", "on_queue", "gate_queued"].includes(status);
  const canRetry = status === "failed";

  const dependencyReason = dependencyBlockedReason(dependsOn);
  // The dependency gate is hard and unconditional, so it takes precedence
  // when both are true — see `stories.md` S2.
  const blockedReason = dependencyReason ?? capacityBlockedReason(capacity);
  const startDisabled = dependencyReason !== null || !capacity.slotAvailable;

  async function call(action: string, url: string, method = "POST") {
    setBusy(action);

    const response = await fetch(url, { method });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(payload.error ?? `Could not ${action} the task.`);
      setBusy(null);
      return;
    }

    toast.success(ACTION_SUCCESS_TOAST[action] ?? `Task ${action} succeeded.`);
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
          disabled={busy !== null || startDisabled}
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
        {canCancel ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => call("cancel", `/api/tasks/${taskId}/cancel`)}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
        {blockedReason ? <span className="text-xs text-muted">{blockedReason}</span> : null}
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
      {/* The approval already succeeded — this is not an error state, just
          an explanation of why the task hasn't resumed yet (S2). Failures are
          reported by toast, so nothing competes with it for this slot. */}
      {status === "gate_queued" && blockedReason ? (
        <span className="text-xs text-muted">{blockedReason}</span>
      ) : null}
    </div>
  );
}
