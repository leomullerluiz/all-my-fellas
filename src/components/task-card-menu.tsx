"use client";

import { MoreVertical } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Start / Edit / Delete menu on a not-yet-started card.
 *
 * The trigger is a sibling of the card's title link, never a descendant: a
 * `<button>` inside an `<a>` is invalid HTML and breaks keyboard and screen
 * reader navigation.
 */

export type CardMenuCapacity = {
  slotAvailable: boolean;
  limit: number;
  blocking: Array<{ id: string; title: string }>;
};

type Action = "start" | "delete" | null;

export function TaskCardMenu({
  taskId,
  taskTitle,
  capacity,
}: {
  taskId: string;
  taskTitle: string;
  capacity: CardMenuCapacity;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  /** Moves focus between menu items with the arrow keys. */
  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();

    const items = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    ).filter((item) => !item.hasAttribute("aria-disabled"));
    if (items.length === 0) return;

    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

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
    if (!capacity.slotAvailable) return;
    void call("start", `/api/tasks/${taskId}/start`, "POST");
  }

  function onDelete() {
    const confirmed = window.confirm(
      `Delete "${taskTitle}"? This removes the task permanently and cannot be undone.`,
    );
    if (!confirmed) return;
    void call("delete", `/api/tasks/${taskId}`, "DELETE");
  }

  const blockedReason = capacity.slotAvailable
    ? null
    : `Limit of ${capacity.limit} task${capacity.limit === 1 ? "" : "s"} in progress reached` +
      (capacity.blocking[0] ? ` — ${capacity.blocking[0].title} is still running.` : ".");

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Task actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={pending !== null}
        onClick={() => setOpen((value) => !value)}
        className="-mr-1 -mt-0.5 rounded p-1 text-muted transition-colors hover:bg-border/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
      >
        <MoreVertical className="size-4" aria-hidden />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${taskTitle}`}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={onStart}
            disabled={pending !== null}
            aria-disabled={!capacity.slotAvailable || undefined}
            title={blockedReason ?? undefined}
            className={cn(
              "block w-full px-3 py-2 text-left text-xs transition-colors",
              capacity.slotAvailable
                ? "hover:bg-border/40"
                : "cursor-not-allowed text-muted/60",
            )}
          >
            {pending === "start" ? "Starting…" : "Start"}
          </button>

          <a
            role="menuitem"
            href={`/tasks/${taskId}/edit`}
            className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-border/40"
          >
            Edit
          </a>

          <button
            type="button"
            role="menuitem"
            onClick={onDelete}
            disabled={pending !== null}
            className="block w-full border-t border-border px-3 py-2 text-left text-xs text-danger transition-colors hover:bg-danger/10"
          >
            {pending === "delete" ? "Deleting…" : "Delete"}
          </button>

          {blockedReason ? (
            <p className="border-t border-border px-3 py-2 text-[10px] leading-snug text-muted">
              {blockedReason}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="absolute right-0 top-full z-20 mt-1 w-52 rounded border border-danger/40 bg-surface-raised px-2 py-1 text-[10px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
