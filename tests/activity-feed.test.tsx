// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityFeed, type ActivityEntry } from "@/components/activity-feed";

/**
 * S6 §6.3 — same fake-`EventSource` pattern as `live-log-connection.test.tsx`.
 * `ActivityFeed` must reuse the existing global `/api/events/stream` route
 * rather than a second stream implementation, so these tests assert it opens
 * exactly that URL (cursored from the initial page's newest entry) and
 * prepends what arrives on it — no data-layer changes needed.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function lastInstance(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1);
  if (!instance) throw new Error("No FakeEventSource was constructed.");
  return instance;
}

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 10,
    taskId: "task_1",
    taskTitle: "Refactor billing",
    createdAt: Date.UTC(2026, 7, 5, 12, 0, 0),
    payload: { type: "task_started" },
    actor: null,
    ...overrides,
  };
}

describe("ActivityFeed", () => {
  it("shows an empty state when there is nothing to show", () => {
    render(<ActivityFeed initial={[]} />);
    expect(screen.getByText("Nothing has happened yet.")).toBeTruthy();
  });

  it("renders the initial, server-provided entries", () => {
    render(<ActivityFeed initial={[entry()]} />);
    expect(screen.getByText("Refactor billing")).toBeTruthy();
    expect(screen.getByText(/Task started/)).toBeTruthy();
  });

  it("opens the existing global SSE route, cursored from the newest initial entry", () => {
    render(<ActivityFeed initial={[entry({ id: 42 })]} />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events/stream?after=42");
  });

  it("prepends a live event arriving on the stream, newest first", () => {
    render(<ActivityFeed initial={[entry({ id: 1, taskTitle: "Older task" })]} />);

    act(() => {
      lastInstance().emit("message", {
        id: 2,
        taskId: "task_2",
        createdAt: Date.UTC(2026, 7, 5, 12, 5, 0),
        payload: { type: "task_started" },
      });
    });

    const rows = screen.getAllByText(/Task started|task_started/);
    expect(rows.length).toBeGreaterThan(0);
    // The live event's task id is used as a fallback title (the stream
    // frame doesn't carry the title) and appears before the older entry.
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("task_2");
    expect(items[1].textContent).toContain("Older task");
  });

  it("shows which token authenticated an entry, and shows nothing for a browser-originated one", () => {
    render(
      <ActivityFeed
        initial={[
          entry({ id: 1, actor: "CI" }),
          entry({ id: 2, taskId: "task_2", taskTitle: "Second task", actor: null }),
        ]}
      />,
    );
    expect(screen.getByText("via CI")).toBeTruthy();
    expect(screen.queryByText("via null")).toBeNull();
  });

  it("carries the actor from a live event onto the prepended row", () => {
    render(<ActivityFeed initial={[entry({ id: 1 })]} />);

    act(() => {
      lastInstance().emit("message", {
        id: 2,
        taskId: "task_2",
        createdAt: Date.UTC(2026, 7, 5, 12, 5, 0),
        payload: { type: "task_started" },
        actor: "phone",
      });
    });

    expect(screen.getByText("via phone")).toBeTruthy();
  });

  it("ignores a malformed frame instead of tearing the stream down", () => {
    render(<ActivityFeed initial={[entry()]} />);

    act(() => {
      const event = { data: "not json" } as MessageEvent<string>;
      for (const listener of lastInstance().listeners.get("message") ?? []) listener(event);
    });

    expect(lastInstance().closed).toBe(false);
    expect(screen.getByText("Refactor billing")).toBeTruthy();
  });
});
