import { describe, expect, it } from "vitest";

import { isBatchEligibleForAnyVerb, isBatchSelectable } from "@/lib/batch-eligibility";

/**
 * S4 §7.2/§7.3 — the shared predicate behind the board checkbox, the batch
 * action bar's per-verb enable/disable, and `BatchSelectionProvider`'s
 * per-render pruning.
 */
describe("isBatchSelectable", () => {
  it("start: only a CREATED/queued task", () => {
    expect(isBatchSelectable({ status: "queued" }, "start")).toBe(true);
    expect(isBatchSelectable({ status: "on_queue" }, "start")).toBe(false);
    expect(isBatchSelectable({ status: "running" }, "start")).toBe(false);
  });

  it("archive: any task that isn't already archived", () => {
    expect(isBatchSelectable({ status: "running", archivedAt: null }, "archive")).toBe(true);
    expect(isBatchSelectable({ status: "completed", archivedAt: null }, "archive")).toBe(true);
    expect(isBatchSelectable({ status: "completed", archivedAt: Date.now() }, "archive")).toBe(false);
  });

  it("cancel: running, awaiting_gate, on_queue, gate_queued only", () => {
    for (const status of ["running", "awaiting_gate", "on_queue", "gate_queued"] as const) {
      expect(isBatchSelectable({ status }, "cancel")).toBe(true);
    }
    for (const status of ["queued", "completed", "rejected", "failed", "cancelled"] as const) {
      expect(isBatchSelectable({ status }, "cancel")).toBe(false);
    }
  });
});

describe("isBatchEligibleForAnyVerb", () => {
  it("is true for a task eligible for at least one verb", () => {
    expect(isBatchEligibleForAnyVerb({ status: "queued", archivedAt: null })).toBe(true);
    expect(isBatchEligibleForAnyVerb({ status: "running", archivedAt: null })).toBe(true);
    expect(isBatchEligibleForAnyVerb({ status: "completed", archivedAt: null })).toBe(true);
  });

  it("is false for an already-archived, non-cancellable, non-startable task", () => {
    expect(isBatchEligibleForAnyVerb({ status: "completed", archivedAt: Date.now() })).toBe(false);
  });
});
