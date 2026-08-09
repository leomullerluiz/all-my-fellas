"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeAge } from "@/lib/utils";
import { STAGE_LABELS, type Gate } from "@/server/pipeline/stages";

/**
 * S6 §6.2 — a cross-task "what needs a decision" panel above the board,
 * backed by `listTasks({ status: "awaiting_gate" })` (already a plain query,
 * no new data-layer work needed). Reuses `GatePanel`'s endpoint
 * (`POST /api/tasks/:id/gates/:gate`) for inline approve/reject.
 *
 * `HUMAN_CODE_REVIEW` never gets an inline decision — approving a diff
 * without opening it is exactly the rubber-stamping the gate exists to
 * prevent (§6.2's explicit carve-out). That row links to the review screen
 * instead.
 */
export type NeedsMeTask = { id: string; title: string; currentStage: Gate; updatedAt: number };

function NeedsMeRow({ task, now }: { task: NeedsMeTask; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const isReview = task.currentStage === "HUMAN_CODE_REVIEW";

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    try {
      const response = await fetch(`/api/tasks/${task.id}/gates/${task.currentStage}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (response.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-1.5 text-xs last:border-b-0">
      <div className="min-w-0">
        <Link href={`/tasks/${task.id}`} className="truncate font-medium hover:text-accent">
          {task.title}
        </Link>
        <span className="ml-1.5 text-muted">
          {STAGE_LABELS[task.currentStage]} · waiting {formatRelativeAge(now - task.updatedAt)}
        </span>
      </div>
      {isReview ? (
        <Link
          href={`/tasks/${task.id}/review`}
          className="shrink-0 text-accent underline-offset-2 hover:underline"
        >
          Open the diff viewer →
        </Link>
      ) : (
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="success" disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" ? "…" : "Approve"}
          </Button>
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => decide("reject")}>
            {busy === "reject" ? "…" : "Reject"}
          </Button>
        </div>
      )}
    </li>
  );
}

export function NeedsMePanel({ tasks, now }: { tasks: NeedsMeTask[]; now: number }) {
  if (tasks.length === 0) return null;

  return (
    <Card className="mb-4 border-warning/40">
      <CardHeader>
        <CardTitle className="text-warning">Needs you ({tasks.length})</CardTitle>
      </CardHeader>
      <CardBody>
        <ul>
          {tasks.map((task) => (
            <NeedsMeRow key={task.id} task={task} now={now} />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
