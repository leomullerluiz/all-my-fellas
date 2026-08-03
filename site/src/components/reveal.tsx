"use client";

import { Effect, type EffectProps } from "@/components/animate-ui/primitives/effects/effect";

/**
 * House entrance animation: fade up out of a slight blur when the element
 * scrolls into view, once. Everything on the page reveals through this so the
 * timing reads as one system rather than a dozen unrelated tweens.
 *
 * `inViewOnce` matters here — a section that re-animated every time you scrolled
 * past it would turn a long page into a strobe.
 *
 * Props are spread last so a caller can opt out of any default; the hero passes
 * `inView={false}` to play on load rather than on scroll.
 */
export function Reveal(props: EffectProps) {
  return (
    <Effect
      inView
      inViewOnce
      inViewMargin="-72px"
      fade
      blur={{ initialBlur: 5 }}
      slide={{ direction: "up", offset: 16 }}
      transition={{ type: "spring", stiffness: 190, damping: 26 }}
      {...props}
    />
  );
}
