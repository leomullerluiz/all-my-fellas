"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { DiffViewer } from "@/components/diff-viewer";
import { GatePanel } from "@/components/task-actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import type { VerificationSummary } from "@/server/pipeline/verification-summary";

type GateProvider = { displayName: string; changeRequestNoun: string };

type WorkspaceStatus = { available: boolean; dirty: boolean };

/**
 * The `HUMAN_CODE_REVIEW` review screen: the dirty-tree warning, the gate
 * decision, and the diff, composed so a successful commit refreshes the diff
 * without a full page reload (S3).
 *
 * `DiffViewer` only fetches on mount, so it is remounted (via `key`) rather
 * than told to refetch — the simplest way to guarantee it shows the new
 * commit without duplicating its fetch logic here.
 */
export function ReviewBoard({
  taskId,
  atGate,
  provider,
  diffSummary,
  verification,
}: {
  taskId: string;
  atGate: boolean;
  provider: GateProvider;
  diffSummary?: string | null;
  verification?: VerificationSummary | null;
}) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [committing, setCommitting] = useState(false);
  const [diffRefreshToken, setDiffRefreshToken] = useState(0);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/workspace/status`);
      if (!response.ok) {
        setStatus({ available: false, dirty: false });
        return;
      }
      const payload = (await response.json()) as WorkspaceStatus;
      setStatus(payload);
    } catch {
      // A failed check must not block the reviewer — it just shows no warning.
      setStatus({ available: false, dirty: false });
    }
  }, [taskId]);

  useEffect(() => {
    void (async () => {
      await loadStatus();
    })();
  }, [loadStatus]);

  async function commitChanges() {
    setCommitting(true);
    const response = await fetch(`/api/tasks/${taskId}/workspace/commit`, { method: "POST" });
    setCommitting(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(payload.error ?? "Could not commit the changes.");
      return;
    }

    toast.success("Uncommitted changes committed.");
    setDiffRefreshToken((token) => token + 1);
    void loadStatus();
  }

  const dirty = status?.available && status.dirty;

  return (
    <div className="flex flex-col gap-5">
      {dirty ? (
        <Card className="border-warning/40">
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-warning">
              This workspace has uncommitted changes. They are <strong>not</strong> part of the
              diff below and will <strong>not</strong> be delivered. Commit them, or discard them.
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={committing}
              onClick={() => void commitChanges()}
            >
              {committing ? "Committing…" : "Commit changes"}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {atGate ? (
        <GatePanel
          taskId={taskId}
          gate="HUMAN_CODE_REVIEW"
          provider={provider}
          diffSummary={diffSummary}
          verification={verification}
        />
      ) : null}

      <DiffViewer key={diffRefreshToken} taskId={taskId} />
    </div>
  );
}
