"use client";

import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Pulsing status dot for a running task's board card.
 *
 * Animates `opacity` and `scale` only — never a property that changes the
 * element's own box size or its neighbors' layout — so the pulse never
 * causes layout shift. `MotionProvider` (mounted in the root layout) already
 * honours `prefers-reduced-motion: reduce` for every Motion component: the
 * scale animation is dropped and only a gentle opacity crossfade remains,
 * mirroring the `animation: none` fallback this replaces in globals.css.
 */
export function PulseDot({ className, ...props }: HTMLMotionProps<"span">) {
  return (
    <motion.span
      animate={{ opacity: [1, 0.45, 1], scale: [1, 0.82, 1] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      className={cn("inline-block size-2 shrink-0 rounded-full bg-accent", className)}
      {...props}
    />
  );
}
