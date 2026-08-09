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
import {
  isBatchEligibleForAnyVerb,
  isBatchSelectable,
  type BatchEligibilityTask,
  type BatchVerb,
} from "@/lib/batch-eligibility";

/**
 * Multi-select state shared by the checkbox on every card (`task-board.tsx`)
 * and the batch action bar in the dashboard header (`page.tsx`) — siblings
 * several components apart, so a small Context is simpler than lifting the
 * whole board into `page.tsx`'s local state.
 *
 * S4 (`spec-board-at-scale.md` §7.1/§7.3) widened this from a Start-only,
 * `notStarted`-only selection into one covering every task and three verbs
 * (Start / Archive / Cancel). This file keeps its original name/path
 * (`batch-start.tsx`) rather than the rename `techplan.md` proposed
 * (`batch-selection.tsx`) — every existing import site and test file
 * referenced the old path, and renaming added file churn with no behavioral
 * benefit; see the dev report's noted deviation.
 */

type SelectableTask = { id: string } & BatchEligibilityTask;

type BatchSelectionContextValue = {
  selected: Set<string>;
  toggle: (taskId: string) => void;
  clear: () => void;
  /** For the action bar's per-verb enable/disable and mixed-selection copy. */
  tasksById: Map<string, SelectableTask>;
};

const BatchSelectionContext = createContext<BatchSelectionContextValue | null>(null);

export function BatchSelectionProvider({
  children,
  tasks,
}: {
  children: ReactNode;
  /**
   * The board's currently-rendered tasks (id, status, archivedAt — enough to
   * judge eligibility for every verb). Read on every render, a fresh
   * (possibly different) array each time the dashboard route re-renders — a
   * full load, the `AutoRefresh` poll, or `router.refresh()` after an
   * unrelated single-task action.
   *
   * Unlike the digest string this replaces (`techplan.md`'s §7.1), an
   * unrelated task changing stage no longer clears the *entire* selection:
   * only the specific ids that vanished from `tasks` or became ineligible
   * for every batch verb are dropped, computed fresh each render rather than
   * compared against a single "did anything change" flag.
   */
  tasks: SelectableTask[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  // "Adjusting state during render" (see react.dev), not a `useEffect` +
  // `setState`: an id that is no longer present, or present but ineligible
  // for every verb, is pruned; every other selected id is left untouched.
  // Conditioned on there being something to prune, so this settles after one
  // corrective render rather than looping.
  const stale = [...selected].filter((id) => {
    const task = tasksById.get(id);
    return !task || !isBatchEligibleForAnyVerb(task);
  });
  if (stale.length > 0) {
    const staleSet = new Set(stale);
    setSelected((current) => new Set([...current].filter((id) => !staleSet.has(id))));
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

  const value = useMemo(
    () => ({ selected, toggle, clear, tasksById }),
    [selected, toggle, clear, tasksById],
  );

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
 * Checkbox on any card. Adds/removes the task from the batch selection; a
 * sibling of the title `Link` and the card's menu trigger, never nested in
 * either, so it doesn't interfere with navigation or the menu's own click
 * handling.
 *
 * Renders unconditionally now (S4) — every task is a valid target for at
 * least one of Start/Archive/Cancel, so the menu/verb decides what's
 * possible rather than the checkbox's mere presence.
 */
export function TaskSelectCheckbox({ taskId, taskTitle }: { taskId: string; taskTitle: string }) {
  const { selected, toggle } = useBatchSelection();

  return (
    <input
      type="checkbox"
      checked={selected.has(taskId)}
      onChange={() => toggle(taskId)}
      aria-label={`Select "${taskTitle}" for a batch action`}
      className="mt-1.5 size-3.5 shrink-0 accent-accent"
    />
  );
}

type StartResult = {
  taskId: string;
  title: string;
  started: boolean;
  /** True when the task was parked on the "On Queue" column rather than genuinely failing. */
  queued: boolean;
  reason: string | null;
};

type ArchiveResult = { taskId: string; title: string; archived: boolean; reason: string | null };
type CancelResult = { taskId: string; title: string; cancelled: boolean; reason: string | null };

const VERB_LABEL: Record<BatchVerb, string> = { start: "Start", archive: "Archive", cancel: "Cancel" };

/**
 * The dashboard header's batch bar: one button per verb, each enabled only
 * when at least one selected task supports it (S4 — `spec-board-at-scale.md`
 * §7.2/§7.3). Batch Delete is deliberately not offered anywhere — deletion
 * stays `CREATED`-only and single-task; archiving is what covers the "get
 * this off my board" need at scale.
 */
export function BatchStartButton() {
  const router = useRouter();
  const { selected, clear, tasksById } = useBatchSelection();
  const [pending, setPending] = useState<BatchVerb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startSummary, setStartSummary] = useState<StartResult[] | null>(null);
  const [archiveSummary, setArchiveSummary] = useState<ArchiveResult[] | null>(null);
  const [cancelSummary, setCancelSummary] = useState<CancelResult[] | null>(null);

  const count = selected.size;
  const selectedTasks = [...selected].map((id) => tasksById.get(id)).filter((t): t is SelectableTask => !!t);

  const eligibleFor = useCallback(
    (verb: BatchVerb) => selectedTasks.filter((task) => isBatchSelectable(task, verb)),
    [selectedTasks],
  );

  async function run(verb: BatchVerb, url: string) {
    setPending(verb);
    setError(null);
    setStartSummary(null);
    setArchiveSummary(null);
    setCancelSummary(null);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: Array.from(selected) }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Could not ${verb} the selected tasks.`);
        setPending(null);
        return;
      }

      const payload = (await response.json()) as {
        results: StartResult[] | ArchiveResult[] | CancelResult[];
      };
      if (verb === "start") setStartSummary(payload.results as StartResult[]);
      if (verb === "archive") setArchiveSummary(payload.results as ArchiveResult[]);
      if (verb === "cancel") setCancelSummary(payload.results as CancelResult[]);
      clear();
      router.refresh();
    } catch {
      // The selection is deliberately left untouched here — a network error
      // means nothing was attempted, so there is nothing to lose by retrying
      // the same selection, matching `TaskCardMenu.call()`'s failure handling.
      setError("The request failed. Is the server still running?");
    }
    setPending(null);
  }

  const startedCount = startSummary?.filter((r) => r.started).length ?? 0;
  const queued = startSummary?.filter((r) => r.queued) ?? [];
  const startFailed = startSummary?.filter((r) => !r.started && !r.queued) ?? [];

  const archivedCount = archiveSummary?.filter((r) => r.archived).length ?? 0;
  const archiveFailed = archiveSummary?.filter((r) => !r.archived) ?? [];

  const cancelledCount = cancelSummary?.filter((r) => r.cancelled).length ?? 0;
  const cancelFailed = cancelSummary?.filter((r) => !r.cancelled) ?? [];

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={eligibleFor("start").length === 0 || pending !== null}
          title={
            count > 0 && eligibleFor("start").length < count
              ? `${count - eligibleFor("start").length} selected task(s) cannot be started.`
              : undefined
          }
          onClick={() => run("start", "/api/tasks/batch-start")}
        >
          {pending === "start" ? "Starting…" : `${VERB_LABEL.start} selected${count > 0 ? ` (${eligibleFor("start").length})` : ""}`}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={eligibleFor("archive").length === 0 || pending !== null}
          title={
            count > 0 && eligibleFor("archive").length < count
              ? `${count - eligibleFor("archive").length} selected task(s) cannot be archived.`
              : undefined
          }
          onClick={() => run("archive", "/api/tasks/batch-archive")}
        >
          {pending === "archive" ? "Archiving…" : `${VERB_LABEL.archive}${count > 0 ? ` (${eligibleFor("archive").length})` : ""}`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={eligibleFor("cancel").length === 0 || pending !== null}
          title={
            count > 0 && eligibleFor("cancel").length < count
              ? `${count - eligibleFor("cancel").length} selected task(s) cannot be cancelled.`
              : undefined
          }
          onClick={() => run("cancel", "/api/tasks/batch-cancel")}
        >
          {pending === "cancel" ? "Cancelling…" : `${VERB_LABEL.cancel}${count > 0 ? ` (${eligibleFor("cancel").length})` : ""}`}
        </Button>
      </div>

      {error ? <p className="max-w-xs text-right text-xs text-danger">{error}</p> : null}

      {startSummary ? (
        <div className="max-w-xs text-right text-xs text-muted">
          <p>
            {startedCount} of {startSummary.length} started
            {queued.length > 0 ? `, ${queued.length} on queue` : ""}
            {startFailed.length > 0 ? " — some tasks could not be started" : ""}
          </p>
          {queued.map((result) => (
            <p key={result.taskId} className="text-[11px] text-muted/80">
              {result.title}: on queue, will start automatically
            </p>
          ))}
          {startFailed.map((result) => (
            <p key={result.taskId} className="text-[11px] text-muted/80">
              {result.title}: {result.reason}
            </p>
          ))}
        </div>
      ) : null}

      {archiveSummary ? (
        <div className="max-w-xs text-right text-xs text-muted">
          <p>
            archive {archivedCount} · {archiveSummary.length} selected task
            {archiveSummary.length === 1 ? "" : "s"}
            {archiveFailed.length > 0 ? ` cannot be archived` : ""}
          </p>
          {archiveFailed.map((result) => (
            <p key={result.taskId} className="text-[11px] text-muted/80">
              {result.title}: {result.reason}
            </p>
          ))}
        </div>
      ) : null}

      {cancelSummary ? (
        <div className="max-w-xs text-right text-xs text-muted">
          <p>
            {cancelledCount} of {cancelSummary.length} cancelled
            {cancelFailed.length > 0 ? " — some tasks could not be cancelled" : ""}
          </p>
          {cancelFailed.map((result) => (
            <p key={result.taskId} className="text-[11px] text-muted/80">
              {result.title}: {result.reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
