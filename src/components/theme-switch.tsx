"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { cn } from "@/lib/utils";
import type { Theme } from "@/server/settings/store";

const OPTIONS: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

/** Applies `theme` to `<html data-theme>` so the palette updates without a reload. */
function applyTheme(theme: Theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

/**
 * Dark / Light / System segmented switch, reachable from every dashboard
 * screen. Applies the choice to the DOM immediately (no flash while the
 * request is in flight) and reverts if the save fails.
 */
export function ThemeSwitch({ initialTheme }: { initialTheme: Theme }) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [busy, setBusy] = useState(false);

  async function select(next: Theme) {
    if (next === theme || busy) return;

    const previous = theme;
    setTheme(next);
    applyTheme(next);
    setBusy(true);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });

      if (!response.ok) {
        setTheme(previous);
        applyTheme(previous);
        return;
      }

      router.refresh();
    } catch {
      setTheme(previous);
      applyTheme(previous);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-md border border-border bg-surface-raised p-0.5"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          title={label}
          disabled={busy}
          onClick={() => select(value)}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50",
            theme === value
              ? "bg-surface text-foreground"
              : "text-muted hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only sm:not-sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
