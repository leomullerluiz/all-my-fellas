"use client";

import { Highlight } from "@/components/animate-ui/primitives/effects/highlight";
import { Reveal } from "@/components/reveal";
import { PROVIDERS } from "@/lib/content";

export function Repositories() {
  return (
    <Reveal>
      {/*
       * `mode="parent"` keeps a single highlight element that measures and
       * animates to whichever row is hovered, instead of one element per row.
       * The rows are plain divs; the wrapper adds the hover behaviour.
       */}
      <Highlight
        mode="parent"
        hover
        containerClassName="overflow-hidden rounded-lg border border-border bg-surface p-2"
        className="rounded-md bg-surface-raised"
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
      >
        {PROVIDERS.map((provider) => (
          <div
            key={provider.name}
            className="grid gap-1 px-3 py-3 sm:grid-cols-[11rem_9rem_1fr] sm:items-baseline sm:gap-4"
          >
            <span className="text-sm font-medium">{provider.name}</span>
            <span
              className={
                provider.integrated
                  ? "text-xs font-medium text-accent"
                  : "text-xs font-medium text-muted"
              }
            >
              {provider.requestName}
            </span>
            <span className="text-xs leading-relaxed text-muted">
              <code className="font-mono text-[11px] text-foreground/80">{provider.variable}</code>
              <span className="mx-1.5 text-border">·</span>
              {provider.note}
            </span>
          </div>
        ))}
      </Highlight>
    </Reveal>
  );
}
