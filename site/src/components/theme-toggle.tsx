"use client";

import { AnimatePresence, motion } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "amf-theme";

type Theme = "dark" | "light";

/**
 * The theme lives in localStorage and on `<html data-theme>`, both of which are
 * outside React. `useSyncExternalStore` is the way to read that without an
 * effect that immediately calls setState — and it gives the toggle and the OS
 * media query a single path to re-render through.
 */
const themeStore = {
  listeners: new Set<() => void>(),

  emit() {
    for (const listener of themeStore.listeners) listener();
  },

  subscribe(listener: () => void) {
    themeStore.listeners.add(listener);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    // Only matters while no explicit choice is stored, but subscribing
    // unconditionally keeps the teardown symmetrical.
    media.addEventListener("change", themeStore.emit);
    return () => {
      themeStore.listeners.delete(listener);
      media.removeEventListener("change", themeStore.emit);
    };
  },

  /** Same resolution order as the inline script in the layout. */
  get(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  },

  set(theme: Theme) {
    localStorage.setItem(STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
    themeStore.emit();
  },
};

export function ThemeToggle() {
  // `null` on the server: the prerendered HTML cannot know which theme is
  // stored, so it ships no icon rather than the wrong one.
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get, () => null);

  return (
    <button
      type="button"
      onClick={() => themeStore.set(theme === "light" ? "dark" : "light")}
      aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      className="relative flex size-8 items-center justify-center rounded-md border border-border bg-surface text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {theme && (
          <motion.span
            key={theme}
            initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
            transition={{ duration: 0.2 }}
            className="flex items-center justify-center"
          >
            {theme === "light" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
