"use client";

import { PulseDot } from "@/components/pulse-dot";
import type { ExecutionCopy } from "@/lib/execution-copy";

/**
 * The one dot every non-`idle` {@link ExecutionCopy} renders as — pulsing for
 * `in_flight`, static everywhere else. Shared by the board and the task detail
 * page so the two surfaces render the same state identically.
 */
export function ExecutionDot({ copy, className }: { copy: ExecutionCopy; className?: string }) {
  if (copy.pulse) {
    return <PulseDot className={className} title={copy.text} aria-label={copy.text} />;
  }
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${
        copy.tone === "accent" ? "bg-accent" : "bg-warning"
      } ${className ?? ""}`}
      title={copy.text}
      aria-label={copy.text}
    />
  );
}
