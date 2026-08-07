"use client";

import { MoreVertical } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import { ErrorMessage } from "@/components/error-message";
import { dropdownMenuItemClassName } from "@/components/task-card-menu";
import { cn } from "@/lib/utils";

/**
 * Options menu for a card in the "Not delivered" column (`REJECTED`,
 * `FAILED`, or `CANCELLED`). Its only action, "Move to Created", is a full
 * reset back to `CREATED` rather than the in-place stage re-run
 * `TaskCardMenu`'s sibling, `POST /api/tasks/:id/retry`, performs — see
 * `techplan.md`'s rationale for keeping the two menus separate.
 *
 * The trigger is a sibling of the card's title link, never a descendant —
 * same constraint `TaskCardMenu` observes, for the same reason (a `<button>`
 * inside an `<a>` is invalid HTML and breaks keyboard/screen-reader
 * navigation).
 */
export function ClosedTaskCardMenu({
  taskId,
  taskTitle,
}: {
  taskId: string;
  taskTitle: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onMoveToCreated() {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/reopen`, { method: "POST" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "Could not move the task to Created.");
        setPending(false);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("The request failed. Is the server still running?");
    }
    setPending(false);
  }

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
            disabled={pending}
            onSelect={(event) => {
              event.preventDefault();
              void onMoveToCreated();
            }}
            className={cn(dropdownMenuItemClassName, "hover:bg-border/40")}
          >
            {pending ? "Moving…" : "Move to Created"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ErrorMessage
        message={error}
        className="absolute right-0 top-full z-20 mt-1 w-52 rounded border border-danger/40 bg-surface-raised px-2 py-1 text-[10px]"
      />
    </div>
  );
}
