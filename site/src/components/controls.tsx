import { Reveal } from "@/components/reveal";
import { CONTROLS } from "@/lib/content";

/**
 * The operational surface, as a numbered grid rather than another icon grid:
 * the page already has one of those in Guardrails, and two side by side read
 * as the same section twice.
 */
export function Controls() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {CONTROLS.map((control, index) => (
        <Reveal key={control.title} delay={(index % 3) * 70}>
          <div className="flex h-full flex-col rounded-lg border border-border bg-surface p-5">
            <span className="font-mono text-[11px] text-accent" aria-hidden>
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 text-sm font-semibold tracking-tight">{control.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{control.body}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
