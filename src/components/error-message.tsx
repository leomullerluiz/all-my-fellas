"use client";

import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Shared enter/exit transition for inline form and action error text.
 *
 * Animates `opacity`/`transform` only — never a property that changes the
 * element's layout box size — so an error appearing or disappearing never
 * shifts surrounding content. `MotionProvider` (mounted in the root layout)
 * already reduces this to an opacity-only crossfade under
 * `prefers-reduced-motion: reduce`.
 */
export function ErrorMessage({
  message,
  className,
}: {
  message: string | null | undefined;
  className?: string;
}) {
  return (
    <AnimatePresence>
      {message ? (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className={cn("text-xs text-danger", className)}
        >
          {message}
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}
