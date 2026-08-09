import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * S2 §4.3 — three bookmark chips above the board, rendered server-side (no
 * client hook, no `useSearchParams()` Suspense concern) since `page.tsx`
 * already knows which view is active from the `searchParams` it parsed.
 *
 * Deliberately not a new concept: each chip is just a link to a URL the
 * filter bar could also produce, with a name.
 */
export type SavedViewKey = "needs-me" | "active" | "everything";

const VIEWS: Array<{ key: SavedViewKey; label: string; href: string }> = [
  { key: "needs-me", label: "Needs me", href: "/?status=awaiting_gate&range=all" },
  { key: "active", label: "Active", href: "/?view=active&range=all" },
  { key: "everything", label: "Everything", href: "/?range=all" },
];

export function SavedViews({ active }: { active: SavedViewKey | null }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {VIEWS.map((view) => (
        <Link
          key={view.key}
          href={view.href}
          aria-current={active === view.key ? "true" : undefined}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
            active === view.key
              ? "border-accent bg-accent/10 text-accent"
              : "border-border text-muted hover:border-accent/50 hover:text-foreground",
          )}
        >
          {view.label}
        </Link>
      ))}
    </div>
  );
}
