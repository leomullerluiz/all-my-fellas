"use client";

import { Tilt, TiltContent } from "@/components/animate-ui/primitives/effects/tilt";
import { Reveal } from "@/components/reveal";
import { PILLARS } from "@/lib/content";

export function Pillars() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {PILLARS.map((pillar, index) => (
        <Reveal key={pillar.title} delay={index * 80}>
          {/*
           * A small tilt — 5 degrees, not 20. The card should feel like it has
           * a surface, not like it is being thrown at the reader.
           */}
          <Tilt maxTilt={5} perspective={1200} className="h-full">
            <TiltContent className="flex h-full flex-col rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent/40">
              <p className="text-sm font-medium text-accent">{pillar.lede}</p>
              <h3 className="mt-2 text-base font-semibold tracking-tight">{pillar.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{pillar.body}</p>
            </TiltContent>
          </Tilt>
        </Reveal>
      ))}
    </div>
  );
}
