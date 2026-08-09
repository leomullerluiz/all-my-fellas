"use client";

import { MoreVertical } from "lucide-react";
import { useRouter } from "next/navigation";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import { ErrorMessage } from "@/components/error-message";
import { capacityBlockedReason } from "@/lib/capacity";
import { dependencyBlockedReason } from "@/lib/dependencies";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/server/pipeline/stages";

/**
 * Start / Edit / Delete menu on a not-yet-started card, with a Cancel item
 * added when the task is `on_queue` — S3 needs some UI path that calls
 * `cancelTask` for a queued task, and this menu is where every other
 * `CREATED`-stage action already lives.
 *
 * The trigger is a sibling of the card's title link, never a descendant: a
 * `<button>` inside an `<a>` is invalid HTML and breaks keyboard and screen
 * reader navigation.
 *
 * Built on the animate-ui `DropdownMenu` (Radix underneath), which gives
 * outside-click/Escape-to-close, roving-tabindex arrow-key navigation and
 * `aria-disabled` on the Start item for free — the manual versions of all
 * three used to live here.
 */

export type CardMenuCapacity = {
  slotAvailable: boolean;
  limit: number;
  blocking: Array<{ id: string; title: string }>;
};

/** A prerequisite task, only as much as the block-reason copy needs. */
export type CardMenuDependency = { id: string; title: string; status: string };

type Action = "start" | "cancel" | "delete" | "archive" | "run-next" | null;

export const dropdownMenuItemClassName = cn(
  "focus:text-accent-foreground relative flex w-full cursor-default items-center rounded-sm px-2 py-1.5",
  "text-left text-xs outline-hidden select-none",
  "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
);

export function TaskCardMenu({
  taskId,
  taskTitle,
  status,
  capacity,
  dependsOn = [],
}: {
  taskId: string;
  taskTitle: string;
  /** Only `on_queue` changes this menu — it adds a Cancel item (S3). */
  status: TaskStatus;
  capacity: CardMenuCapacity;
  /** This task's prerequisites, so Start can be disabled independently of capacity. */
  dependsOn?: CardMenuDependency[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: Exclude<Action, null>, url: string, method: string) {
    setPending(action);
    setError(null);

    try {
      const response = await fetch(url, { method });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Could not ${action} the task.`);
        setPending(null);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("The request failed. Is the server still running?");
    }
    setPending(null);
  }

  function onStart() {
    if (pending !== null || startDisabled) return;
    void call("start", `/api/tasks/${taskId}/start`, "POST");
  }

  function onCancel() {
    if (pending !== null) return;
    void call("cancel", `/api/tasks/${taskId}/cancel`, "POST");
  }

  function onDelete() {
    if (pending !== null) return;
    const confirmed = window.confirm(
      `Delete "${taskTitle}"? This removes the task permanently and cannot be undone.`,
    );
    if (!confirmed) return;
    void call("delete", `/api/tasks/${taskId}`, "DELETE");
  }

  function onArchive() {
    if (pending !== null) return;
    void call("archive", `/api/tasks/${taskId}/archive`, "POST");
  }

  function onRunNext() {
    if (pending !== null) return;
    void call("run-next", `/api/tasks/${taskId}/run-next`, "POST");
  }

  const dependencyReason = dependencyBlockedReason(dependsOn);
  const capacityReason = capacityBlockedReason(capacity);
  // The dependency gate is hard and unconditional, so it takes precedence
  // when both are true — see `stories.md` S2.
  const blockedReason = dependencyReason ?? capacityReason;
  const startDisabled = dependencyReason !== null || !capacity.slotAvailable;

  return (
    <div className="relative shrink-0">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Task actions"
            className="-mr-1 -mt-0.5 rounded p-1 text-muted transition-colors hover:bg-border/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            <MoreVertical className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          aria-label={`Actions for ${taskTitle}`}
          className="w-52 border-border bg-surface-raised p-1 text-xs"
        >
          <DropdownMenuItem
            disabled={startDisabled}
            title={blockedReason ?? undefined}
            onSelect={(event) => {
              event.preventDefault();
              onStart();
            }}
            className={cn(
              dropdownMenuItemClassName,
              startDisabled ? "cursor-not-allowed text-muted/60" : "hover:bg-border/40",
            )}
          >
            {pending === "start" ? "Starting…" : "Start"}
          </DropdownMenuItem>

          {/*
           * A real `<a>`, not the vendored DropdownMenuItem: that component
           * hardcodes a `motion.div` as the Radix `Item`'s `asChild` target,
           * so it cannot itself become a link. Using Radix's `Item` directly
           * keeps roving-tabindex/keyboard behavior while letting the DOM
           * node be an actual anchor (ctrl/middle-click to open a new tab
           * still works).
           */}
          <DropdownMenuPrimitive.Item asChild onSelect={() => setOpen(false)}>
            <a
              href={`/tasks/${taskId}/edit`}
              className={cn(dropdownMenuItemClassName, "hover:bg-border/40")}
            >
              Edit
            </a>
          </DropdownMenuPrimitive.Item>

          {status === "on_queue" ? (
            <>
              <DropdownMenuSeparator />
              {/* S7 §8.3 — bumps this task's `updated_at` older than every
                  other queued task's, so it sorts first among ties on
                  priority and difficulty. See `bumpToFrontOfQueue`. */}
              <DropdownMenuItem
                disabled={pending !== null}
                onSelect={(event) => {
                  event.preventDefault();
                  onRunNext();
                }}
                className={cn(dropdownMenuItemClassName, "hover:bg-border/40")}
              >
                {pending === "run-next" ? "Promoting…" : "Run this next"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={pending !== null}
                onSelect={(event) => {
                  event.preventDefault();
                  onCancel();
                }}
                className={cn(dropdownMenuItemClassName, "hover:bg-border/40")}
              >
                {pending === "cancel" ? "Cancelling…" : "Cancel"}
              </DropdownMenuItem>
            </>
          ) : null}

          <DropdownMenuSeparator />
          {/* S3 §5 — soft delete: keeps every row, only hides the task from
              the board/list/picker. Available regardless of status. */}
          <DropdownMenuItem
            disabled={pending !== null}
            onSelect={(event) => {
              event.preventDefault();
              onArchive();
            }}
            className={cn(dropdownMenuItemClassName, "hover:bg-border/40")}
          >
            {pending === "archive" ? "Archiving…" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending !== null}
            onSelect={(event) => {
              event.preventDefault();
              onDelete();
            }}
            className={cn(dropdownMenuItemClassName, "text-danger hover:bg-danger/10")}
          >
            {pending === "delete" ? "Deleting…" : "Delete"}
          </DropdownMenuItem>

          {blockedReason ? (
            <p className="border-t border-border px-2 py-2 text-[10px] leading-snug text-muted">
              {blockedReason}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <ErrorMessage
        message={error}
        className="absolute right-0 top-full z-20 mt-1 w-52 rounded border border-danger/40 bg-surface-raised px-2 py-1 text-[10px]"
      />
    </div>
  );
}
