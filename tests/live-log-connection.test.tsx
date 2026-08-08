// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveLog } from "@/components/live-log";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

/**
 * S2 — the detail page's `live` boolean is narrowed to in_flight /
 * waiting_for_worker / retry_backoff / `awaiting_gate`. `gate_queued` is
 * deliberately excluded: the decision is already recorded and no stage is
 * running, so there is nothing to reconnect to — see
 * `spec-execution-honesty.md` §6.6. This asserts what `LiveLog` does with
 * whatever `live` value it's handed; the detail page's own narrowing is
 * exercised in `tests/api-tasks.test.ts` / the page itself.
 */

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  // jsdom does not implement `scrollIntoView`; `LiveLog`'s "follow" effect
  // calls it unconditionally on every render.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LiveLog connection status", () => {
  it("shows 'closed', not 'reconnecting', when live is false (e.g. gate_queued)", () => {
    render(<LiveLog taskId="task_1" live={false} />);

    expect(screen.getByText("closed")).toBeTruthy();
    expect(screen.queryByText("reconnecting")).toBeNull();
  });

  it("shows 'reconnecting', not 'closed', before the stream opens when live is true", () => {
    render(<LiveLog taskId="task_1" live={true} />);

    expect(screen.getByText("reconnecting")).toBeTruthy();
    expect(screen.queryByText("closed")).toBeNull();
  });
});
