import type { ReactNode } from "react";

import { Reveal } from "@/components/reveal";
import { cn } from "@/lib/utils";

type SectionProps = {
  id: string;
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Shared section chrome: eyebrow, heading and lede all reveal as one group. */
export function Section({ id, eyebrow, title, lede, children, className }: SectionProps) {
  return (
    <section id={id} className={cn("border-b border-border", className)}>
      <div className="mx-auto max-w-[1120px] px-6 py-16 sm:py-20">
        <Reveal>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
            {eyebrow}
          </p>
        </Reveal>
        <Reveal delay={70}>
          <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
            {title}
          </h2>
        </Reveal>
        {lede ? (
          <Reveal delay={130}>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted sm:text-base">{lede}</p>
          </Reveal>
        ) : null}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}
