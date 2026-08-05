"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * `reducedMotion="user"` makes every Motion component on the page honour the
 * OS "reduce motion" setting: transform and layout animations are skipped while
 * opacity still crossfades, so content that animates in is never left invisible.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
