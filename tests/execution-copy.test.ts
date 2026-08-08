import { describe, expect, it } from "vitest";

import { executionCopy } from "@/lib/execution-copy";

/**
 * Pure copy/tone/pulse mapping shared by the board and the task detail page —
 * see `spec-execution-honesty.md` §5. Exercised indirectly through
 * `tests/task-board.test.tsx`; this covers every branch directly, including
 * the `idle` -> `null` case neither of those consumers has its own test for.
 */
describe("executionCopy", () => {
  it("pulses for in_flight, one line of text per job kind, description equal to text", () => {
    expect(executionCopy({ kind: "in_flight", job: "agent" }, 3)).toEqual({
      text: "An agent is running",
      description: "An agent is running",
      tone: "accent",
      pulse: true,
    });
    expect(executionCopy({ kind: "in_flight", job: "delivery" }, 3)).toMatchObject({
      text: "Pushing the branch and opening the change request",
      pulse: true,
    });
    expect(executionCopy({ kind: "in_flight", job: "verification" }, 3)).toMatchObject({
      text: "Running verification commands",
      pulse: true,
    });
  });

  it("never pulses for waiting_for_worker, and states the ordinal and depth", () => {
    const copy = executionCopy({ kind: "waiting_for_worker", position: 2, depth: 5 }, 3);
    expect(copy).toEqual({
      text: "Queued for the worker — 2nd of 5",
      description: "2nd of 5 in the worker queue",
      tone: "accent",
      pulse: false,
    });
  });

  it("never pulses for retry_backoff, and states the attempt out of maxJobAttempts", () => {
    const retryAt = Date.now() + 14_000;
    const copy = executionCopy({ kind: "retry_backoff", retryAt, attempt: 2 }, 3);
    expect(copy?.pulse).toBe(false);
    expect(copy?.tone).toBe("warning");
    expect(copy?.text).toMatch(/^Stage failed; retrying in \d+s \(attempt 2 of 3\)$/);
    expect(copy?.description).toMatch(/^Retrying in \d+s \(attempt 2 of 3\)$/);
  });

  it("never pulses for settling", () => {
    expect(executionCopy({ kind: "settling" }, 3)).toEqual({
      text: "Nothing is queued for this task",
      description: "Admitted, but no job is queued — nothing will happen until it is started again",
      tone: "warning",
      pulse: false,
    });
  });

  it("returns null for idle — every consumer's own status branches cover it instead", () => {
    expect(executionCopy({ kind: "idle" }, 3)).toBeNull();
  });
});
