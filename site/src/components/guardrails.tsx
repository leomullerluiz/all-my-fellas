import { Eye, Hand, History, Layers, Lock, Shield, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/reveal";
import { GUARDRAILS, type Guardrail } from "@/lib/content";

const ICONS: Record<Guardrail["icon"], LucideIcon> = {
  lock: Lock,
  eye: Eye,
  hand: Hand,
  shield: Shield,
  layers: Layers,
  history: History,
};

export function Guardrails() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {GUARDRAILS.map((item, index) => {
        const Icon = ICONS[item.icon];
        // The last card is alone on its row at two columns; let it span.
        const wide = index === GUARDRAILS.length - 1 && GUARDRAILS.length % 2 === 1;

        return (
          <Reveal key={item.title} delay={(index % 2) * 70} className={wide ? "md:col-span-2" : undefined}>
            <div className="flex h-full gap-4 rounded-lg border border-border bg-surface p-5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised text-accent">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold tracking-tight">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
              </div>
            </div>
          </Reveal>
        );
      })}
    </div>
  );
}
