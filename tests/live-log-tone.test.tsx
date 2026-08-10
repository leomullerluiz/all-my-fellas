// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { toneFor } from "@/components/live-log";
import type { PipelineEvent } from "@/server/events/types";

/**
 * `toneFor`'s `default` branch means a missed `PipelineEvent` case compiles
 * cleanly — unlike `describe()`, nothing here fails the build (spec §7,
 * `live-log.tsx:59-62`). The failed/errored/skipped and stderr branches are
 * exactly the ones a silent regression would fall back to the neutral
 * `text-foreground` default without anyone noticing, so they get a direct
 * test instead of relying on totality.
 */
describe("toneFor — verification_finished", () => {
  it("returns a danger tone for a failed run", () => {
    const event: PipelineEvent = { type: "verification_finished", status: "failed" };
    expect(toneFor(event)).toBe("text-danger");
  });

  it("returns a danger tone for an errored run", () => {
    const event: PipelineEvent = {
      type: "verification_finished",
      status: "errored",
      reason: "install could not be spawned",
    };
    expect(toneFor(event)).toBe("text-danger");
  });

  it("returns a warning tone for a skipped run — never the success tone", () => {
    const event: PipelineEvent = { type: "verification_finished", status: "skipped" };
    expect(toneFor(event)).toBe("text-warning");
  });

  it("returns a success tone for a passed run", () => {
    const event: PipelineEvent = { type: "verification_finished", status: "passed" };
    expect(toneFor(event)).toBe("text-success");
  });
});

describe("toneFor — gate_bypassed", () => {
  it("returns a danger tone, distinct from gate_opened's warning tone", () => {
    const event: PipelineEvent = { type: "gate_bypassed", gate: "PLAN_GATE" };
    expect(toneFor(event)).toBe("text-danger");
  });
});

describe("toneFor — verification_output", () => {
  it("tints stderr output with the warning tone", () => {
    const event: PipelineEvent = {
      type: "verification_output",
      kind: "test",
      stream: "stderr",
      chunk: "some failure output",
    };
    expect(toneFor(event)).toBe("text-warning");
  });

  it("leaves stdout output in the foreground tone", () => {
    const event: PipelineEvent = {
      type: "verification_output",
      kind: "test",
      stream: "stdout",
      chunk: "ok",
    };
    expect(toneFor(event)).toBe("text-foreground");
  });
});
