// Type-only: `execution.ts` imports `db`, which cannot be bundled for the
// browser, but a type-only import is erased before bundling — the same
// pattern `task-actions.tsx` already uses for `RetryAvailability`.
import type { ExecutionState } from "@/server/pipeline/execution";

import { ordinal, retryCountdownSeconds } from "./utils";

/**
 * The copy for every non-`idle` {@link ExecutionState}, shared by the board
 * and the task detail page so the two surfaces can never disagree about what
 * a given state means — see `spec-execution-honesty.md` §5.
 *
 * `idle` returns `null` deliberately: every consumer already has its own
 * branches for `notStarted` / `awaiting_gate` / `gate_queued` / closed,
 * derived from `tasks.status` rather than execution state, and those are
 * unaffected by this spec.
 */
export type ExecutionCopy = {
  /** The dot's `title`/`aria-label` — spec §5's "Title / aria-label" column. */
  text: string;
  /**
   * The longer sentence spec §5's "Card line" column specifies — what the
   * task detail page renders next to the dot. `in_flight` has no separate
   * card line in that table (its row reads "—"), so this equals `text`.
   */
  description: string;
  tone: "accent" | "warning";
  /** Only `in_flight` pulses — see `PulseDot`'s docblock. */
  pulse: boolean;
};

type InFlightJob = Extract<ExecutionState, { kind: "in_flight" }>["job"];

const IN_FLIGHT_TEXT: Record<InFlightJob, string> = {
  agent: "An agent is running",
  delivery: "Pushing the branch and opening the change request",
  verification: "Running verification commands",
};

/** `maxJobAttempts` is `MAX_JOB_ATTEMPTS` from `../server/jobs/queue`, threaded in by the caller. */
export function executionCopy(execution: ExecutionState, maxJobAttempts: number): ExecutionCopy | null {
  switch (execution.kind) {
    case "in_flight": {
      const text = IN_FLIGHT_TEXT[execution.job];
      return { text, description: text, tone: "accent", pulse: true };
    }
    case "waiting_for_worker":
      return {
        text: `Queued for the worker — ${ordinal(execution.position)} of ${execution.depth}`,
        description: `${ordinal(execution.position)} of ${execution.depth} in the worker queue`,
        tone: "accent",
        pulse: false,
      };
    case "retry_backoff": {
      const seconds = retryCountdownSeconds(execution.retryAt);
      return {
        text: `Stage failed; retrying in ${seconds}s (attempt ${execution.attempt} of ${maxJobAttempts})`,
        description: `Retrying in ${seconds}s (attempt ${execution.attempt} of ${maxJobAttempts})`,
        tone: "warning",
        pulse: false,
      };
    }
    case "settling":
      return {
        text: "Nothing is queued for this task",
        description:
          "Admitted, but no job is queued — nothing will happen until it is started again",
        tone: "warning",
        pulse: false,
      };
    case "idle":
      return null;
  }
}
