"use client";

import { Toaster } from "@/components/ui/sonner";
import type { Theme } from "@/server/settings/store";

/**
 * Mounts the toast stack once for the whole app. `RootLayout` is a server
 * component, so this is the client boundary that owns Sonner's `Toaster` —
 * every `toast.x()` call anywhere in the tree renders into it. `theme` is
 * threaded down from `getSettings()` rather than read via `next-themes`,
 * which this codebase doesn't use.
 */
export function ToastProvider({ theme }: { theme: Theme }) {
  return <Toaster theme={theme} position="top-right" duration={4000} />;
}
