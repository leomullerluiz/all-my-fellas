"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";

/**
 * Multi-select state shared by the checkbox on each not-yet-started card
 * (`task-board.tsx`) and the "Start selected" button in the dashboard header
 * (`page.tsx`) — siblings several components apart, so a small Context is
 * simpler than lifting the whole board into `page.tsx`'s local state.
 */

type BatchSelectionContextValue = {
  selected: Set<string>;
  toggle: (taskId: string) => void;
  clear: () => void;
};

const BatchSelectionContext = createContext<BatchSelectionContextValue | null>(null);

export function BatchSelectionProvider({
  children,
  boardVersion,
}: {
  children: ReactNode;
  /**
   * A digest of the current task list (id + stage + status), recomputed by
   * `page.tsx` on every request that renders the dashboard route — a fresh
   * page load or any `router.refresh()` (the `AutoRefresh` poll, or
   * `TaskCardMenu.call()`'s refresh after an unrelated single-task action).
   * When this value differs from the last render, the board has reloaded
   * with different task state, so the selection below is reset. Derived
   * from already-fetched data rather than e.g. `Date.now()` so the value
   * stays a pure computation (`react-hooks/purity` forbids impure calls
   * during render) and an idle poll that changed nothing doesn't wipe an
   * in-progress selection.
   */
  boardVersion?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // "Adjusting state when a prop changes" (see react.dev) rather than a
  // `useEffect` + `setState`, which `react-hooks/set-state-in-effect` flags:
  // reset the selection directly during render when the board has reloaded
  // with different task state, distinct from `clear()` below which only
  // runs once a batch action completes (S3).
  const [seenBoardVersion, setSeenBoardVersion] = useState(boardVersion);
  if (boardVersion !== seenBoardVersion) {
    setSeenBoardVersion(boardVersion);
    setSelected(new Set());
  }

  const toggle = useCallback((taskId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  // A fresh `Set` (rather than `.clear()` on the existing one) so components
  // reading `selected` re-render — mutating in place would not change
  // identity and React would miss the update.
  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo(() => ({ selected, toggle, clear }), [selected, toggle, clear]);

  return <BatchSelectionContext value={value}>{children}</BatchSelectionContext>;
}

function useBatchSelection(): BatchSelectionContextValue {
  const context = useContext(BatchSelectionContext);
  if (!context) {
    throw new Error("useBatchSelection must be used within a BatchSelectionProvider");
  }
  return context;
}

/**
 * Checkbox on a `CREATED` card. Adds/removes the task from the batch
 * selection; a sibling of the title `Link` and the `TaskCardMenu` trigger,
 * never nested in either, so it doesn't interfere with navigation or the
 * menu's own click handling.
 */
export function TaskSelectCheckbox({ taskId, taskTitle }: { taskId: string; taskTitle: string }) {
  const { selected, toggle } = useBatchSelection();

  return (
    <input
      type="checkbox"
      checked={selected.has(taskId)}
      onChange={() => toggle(taskId)}
      aria-label={`Select "${taskTitle}" to start in this batch`}
      className="mt-1.5 size-3.5 shrink-0 accent-accent"
    />
  );
}

type BatchResult = {
  taskId: string;
  title: string;
  started: boolean;
  /** True when the task was parked on the "On Queue" column rather than genuinely failing. */
  queued: boolean;
  reason: string | null;
};

/**
 * Top-right "Start selected" button.
 *
 * Runs the batch, then shows a summary of what started, what's on queue, and
 * what genuinely failed — the reason text for anything on queue or failed is
 * whatever the server sent, which for a capacity refusal is the same string
 * `TaskCardMenu`'s `blockedReason` shows (both derive from
 * `capacityBlockedReason`). Queued tasks start automatically as slots free
 * up (see `orchestrator.promoteQueue`), so they are not reported as failures.
 */
export function BatchStartButton() {
  const router = useRouter();
  const { selected, clear } = useBatchSelection();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const count = selected.size;

  async function onClick() {
    setPending(true);
    setError(null);
    setSummary(null);

    try {
      const response = await fetch("/api/tasks/batch-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: Array.from(selected) }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "Could not start the selected tasks.");
        setPending(false);
        return;
      }

      const payload = (await response.json()) as { results: BatchResult[] };
      setSummary(payload.results);
      clear();
      router.refresh();
    } catch {
      // The selection is deliberately left untouched here — a network error
      // means nothing was attempted, so there is nothing to lose by retrying
      // the same selection, matching `TaskCardMenu.call()`'s failure handling.
      setError("The request failed. Is the server still running?");
    }
    setPending(false);
  }

  const startedCount = summary?.filter((result) => result.started).length ?? 0;
  const queued = summary?.filter((result) => result.queued) ?? [];
  const failed = summary?.filter((result) => !result.started && !result.queued) ?? [];

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" disabled={count === 0 || pending} onClick={onClick}>
        {pending ? "Starting…" : count > 0 ? `Start selected (${count})` : "Start selected"}
      </Button>

      {error ? <p className="max-w-xs text-right text-xs text-danger">{error}</p> : null}

      {summary ? (
        <div className="max-w-xs text-right text-xs text-muted">
          <p>
            {startedCount} of {summary.length} started
            {queued.length > 0
              ? `, ${queued.length} on queue`
              : ""}
            {failed.length > 0 ? " — some tasks could not be started" : ""}
          </p>
          {queued.map((result) => (
            <p key={result.taskId} className="text-[11px] text-muted/80">
              {result.title}: on queue, will start automatically
            </p>
          ))}
          {failed.map((result) => (
            <p key={result.taskId} className="text-[11px] text-muted/80">
              {result.title}: {result.reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
