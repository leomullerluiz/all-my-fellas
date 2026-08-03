import { Bot, RotateCcw, Rocket, UserCheck, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/reveal";
import { STAGES, type StageKind } from "@/lib/content";
import { cn } from "@/lib/utils";

type KindStyle = {
  label: string;
  icon: LucideIcon;
  /** Timeline dot. */
  node: string;
  badge: string;
};

const KIND: Record<StageKind, KindStyle> = {
  agent: {
    label: "agent",
    icon: Bot,
    node: "border-accent/40 bg-accent/10 text-accent",
    badge: "border-accent/40 bg-accent/10 text-accent",
  },
  human: {
    label: "human",
    icon: UserCheck,
    node: "border-warning/40 bg-warning/10 text-warning",
    badge: "border-warning/40 bg-warning/10 text-warning",
  },
  worker: {
    label: "worker",
    icon: Rocket,
    node: "border-success/40 bg-success/10 text-success",
    badge: "border-success/40 bg-success/10 text-success",
  },
};

export function Pipeline() {
  return (
    <ol className="relative">
      {/* The spine. Faded at both ends so it reads as a segment, not a border. */}
      <span
        className="absolute left-4 top-4 bottom-4 w-px bg-gradient-to-b from-transparent via-border to-transparent"
        aria-hidden
      />

      {STAGES.map((stage) => {
        const kind = KIND[stage.kind];
        const Icon = kind.icon;

        return (
          <li key={stage.id}>
            {/*
             * One reveal per stage rather than one staggered reveal for the
             * whole list: the stages enter the viewport in order as you scroll,
             * so the stagger comes from the scroll itself and stays in step
             * however fast you move.
             */}
            <Reveal slide={{ direction: "up", offset: 14 }}>
              <div className="relative flex gap-4 pb-5">
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
                    kind.node,
                  )}
                >
                  <Icon className="size-4" />
                </span>

                <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface transition-colors hover:border-accent/40">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3">
                    <h3 className="text-sm font-semibold tracking-tight">{stage.name}</h3>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight",
                        kind.badge,
                      )}
                    >
                      {kind.label}
                    </span>
                    {stage.produces ? (
                      <span className="font-mono text-[11px] text-muted">
                        → {stage.produces}
                      </span>
                    ) : null}
                    <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-wider text-muted/70 sm:inline">
                      {stage.state}
                    </span>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-sm leading-relaxed text-muted">{stage.blurb}</p>
                    <p className="mt-2 font-mono text-[11px] text-muted/80">{stage.tools}</p>
                  </div>
                </div>
              </div>
            </Reveal>
          </li>
        );
      })}

      <li>
        <Reveal>
          <div className="relative flex gap-4">
            <span className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-muted">
              <RotateCcw className="size-4" />
            </span>
            <p className="flex-1 pt-1.5 text-sm leading-relaxed text-muted">
              Code review, QA and a human reviewer can all send the work back to the Developer.
              They share one budget — <span className="font-mono text-[12px]">REWORK_MAX_CYCLES</span>{" "}
              — so a task cannot loop forever. The other terminal states are rejected at a gate,
              failed for a technical reason, and cancelled by you.
            </p>
          </div>
        </Reveal>
      </li>
    </ol>
  );
}
