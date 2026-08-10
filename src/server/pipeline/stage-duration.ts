import type { Stage } from "./stages";

/**
 * Per-stage "typical duration" constants behind the board's "slow" marker
 * (`spec-board-at-scale.md` §3.2). A `running` stage whose elapsed time
 * exceeds its own threshold is "slow"; one under it is not.
 *
 * Deliberately constants rather than a per-stage-and-model median: the
 * product has no run history to compute one from yet (Open Question 2), and
 * a constant that is honest about being a rough guess ("slow", never
 * "stuck") is safer than a median that looks precise but is one bad model
 * choice away from crying wolf on every run. `maxTurns`
 * (`settings/store.ts`'s `defaultSettings`) is the nearest existing signal
 * for "how big is this stage supposed to be" — these thresholds are set in
 * the same relative proportions (`DEVELOPMENT`'s 80 turns vs.
 * `STAKEHOLDER_REFINEMENT`'s 6) rather than picked independently.
 *
 * Gates and terminal stages have no entry: nothing ever renders "slow" for a
 * stage a human, not the worker, is holding up — `awaiting_gate`'s own "d ago"
 * wording already covers that case honestly.
 */
export const SLOW_THRESHOLD_MS: Partial<Record<Stage, number>> = {
  STAKEHOLDER_REFINEMENT: 5 * 60_000,
  PO_REFINEMENT: 8 * 60_000,
  ARCHITECTURE: 15 * 60_000,
  DEVELOPMENT: 30 * 60_000,
  VERIFICATION: 10 * 60_000,
  CODE_REVIEW: 15 * 60_000,
  QA: 15 * 60_000,
  PO_HOMOLOGATION: 8 * 60_000,
  DELIVERY: 5 * 60_000,
};

/** Whether a `running` `stage` that started at `startedAt` counts as "slow" right now. */
export function isSlow(stage: Stage, startedAt: number, now: number = Date.now()): boolean {
  const threshold = SLOW_THRESHOLD_MS[stage];
  if (threshold === undefined) return false;
  return now - startedAt > threshold;
}
