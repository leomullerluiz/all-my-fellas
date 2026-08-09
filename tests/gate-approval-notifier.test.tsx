// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GateApprovalNotifier } from "@/components/gate-approval-notifier";
import { PIPELINE_EVENT_TYPES, type PipelineEvent } from "@/server/events/types";
import type { NotificationSettings } from "@/server/settings/store";

/**
 * S1/S2/S3 — the SSE-wiring behaviour around the pure helpers in
 * `src/lib/gate-notifications.ts`: fires once per new approval-gate event,
 * respects the setting/permission gate, survives a backgrounded tab, never
 * throws when `Notification` is unsupported, dedups a replayed event, does
 * not re-notify a gate already covered by a persisted cursor, and navigates
 * on click.
 */

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<Listener>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as Listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener as Listener);
  }
  close(): void {}
  /** Fires every listener registered for `type` (mirrors a real named SSE event). */
  dispatch(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function envelope(payload: PipelineEvent, id = 1) {
  return { id, taskId: "task_1", seq: 1, stageRunId: null, createdAt: 0, payload };
}

const NOTIFICATIONS_ON: NotificationSettings = {
  browser: true,
  webhookUrl: null,
  webhookSecretRef: null,
  events: Object.fromEntries(PIPELINE_EVENT_TYPES.map((type) => [type, false])) as NotificationSettings["events"],
};

let notificationCtor: (title: string, options?: NotificationOptions) => void;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    notificationCtor(title, options);
    FakeNotification.instances.push(this);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  FakeNotification.instances = [];
  notificationCtor = vi.fn();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("Notification", FakeNotification);
  FakeNotification.permission = "granted";
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function latestSource(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
}

describe("GateApprovalNotifier", () => {
  it("fires exactly one Notification for a gate_opened event on an approval gate", async () => {
    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 1));

    await waitFor(() => expect(notificationCtor).toHaveBeenCalledTimes(1));
  });

  it("still fires while the tab is backgrounded (visibilityState hidden)", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });

    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "HUMAN_CODE_REVIEW" }, 1));

    await waitFor(() => expect(notificationCtor).toHaveBeenCalledTimes(1));
  });

  it("never fires for event types other than gate_opened", async () => {
    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    const source = latestSource();

    source.dispatch("gate_decided", envelope({ type: "gate_decided", gate: "PLAN_GATE", decision: "approve" }, 1));
    source.dispatch("task_finished", envelope({ type: "task_finished", stage: "COMPLETED" }, 2));
    source.dispatch("stage_started", envelope({ type: "stage_started", stage: "DEVELOPMENT", attempt: 1 }, 3));
    source.dispatch("pr_opened", envelope({ type: "pr_opened", url: "https://example.com/pr/1" }, 4));
    source.dispatch("log", envelope({ type: "log", level: "info", message: "hi" }, 5));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not double-fire when the same event id is delivered twice (reconnect replay)", async () => {
    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    const source = latestSource();
    const payload = envelope({ type: "gate_opened", gate: "STAKEHOLDER_GATE" }, 7);

    source.dispatch("gate_opened", payload);
    source.dispatch("gate_opened", payload);

    await waitFor(() => expect(notificationCtor).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("does not notify for an event id already covered by a persisted cursor (reload)", async () => {
    window.localStorage.setItem("gate-approval-notifier:cursor", "10");

    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 5));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not notify when notifications.browser is false", async () => {
    render(<GateApprovalNotifier notifications={{ ...NOTIFICATIONS_ON, browser: false }} />);
    latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 1));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not notify when permission is denied", async () => {
    FakeNotification.permission = "denied";
    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 1));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not notify when permission is default", async () => {
    FakeNotification.permission = "default";
    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 1));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not throw and still renders when window.Notification is unsupported", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("EventSource", FakeEventSource);
    // @ts-expect-error deliberately simulating an unsupported browser
    delete window.Notification;
    FakeEventSource.instances = [];

    expect(() => render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />)).not.toThrow();
    expect(() =>
      latestSource().dispatch("gate_opened", envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 1)),
    ).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("navigates to /tasks/:id when the notification is clicked", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
      configurable: true,
    });

    render(<GateApprovalNotifier notifications={NOTIFICATIONS_ON} />);
    latestSource().dispatch(
      "gate_opened",
      envelope({ type: "gate_opened", gate: "PLAN_GATE" }, 1),
    );

    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));

    FakeNotification.instances[0]!.onclick?.();

    expect(assign).toHaveBeenCalledWith(expect.stringContaining("/tasks/task_1"));
  });
});
