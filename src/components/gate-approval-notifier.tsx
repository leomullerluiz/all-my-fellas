"use client";

import { useEffect, useRef } from "react";

import {
  buildGateNotificationCopy,
  canShowBrowserNotifications,
  createCursorGate,
  isApprovalGateOpened,
  type StreamEnvelope,
} from "@/lib/gate-notifications";
import { PIPELINE_EVENT_TYPES } from "@/server/events/types";
import type { NotificationSettings } from "@/server/settings/store";

/**
 * Mounted once from `DashboardLayout` (stories.md S1). Tails the board-wide
 * `GET /api/events/stream` and fires a desktop `Notification` the moment any
 * task transitions into an approval gate, regardless of which route or task
 * is currently open — see `src/lib/gate-notifications.ts` for the pure
 * filtering/dedup/copy logic this wires up to `EventSource` and
 * `Notification`. Renders nothing.
 *
 * `localStorage` is new to this codebase (no prior usage), so both reads and
 * writes are wrapped in `try/catch`: a blocked storage API (private
 * browsing, storage quota, disabled cookies) degrades to "always tail from
 * id 0" rather than taking the notifier — and the surrounding layout — down.
 */

const CURSOR_STORAGE_KEY = "gate-approval-notifier:cursor";

function readStoredCursor(): number {
  try {
    const raw = window.localStorage.getItem(CURSOR_STORAGE_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function persistCursor(id: number): void {
  try {
    window.localStorage.setItem(CURSOR_STORAGE_KEY, String(id));
  } catch {
    // Nothing to persist to — the next connection just re-tails from 0.
  }
}

/**
 * Best-effort title lookup via the existing `GET /api/tasks/:id` route
 * (§ techplan.md — enriching `gate_opened` itself was rejected). A failed or
 * slow fetch still resolves to a `Notification`, just with the task id
 * standing in for its title.
 */
async function notifyApprovalGate(envelope: StreamEnvelope): Promise<void> {
  let title = envelope.taskId;
  try {
    const response = await fetch(`/api/tasks/${envelope.taskId}`);
    if (response.ok) {
      const data = (await response.json()) as { task: { title: string } };
      title = data.task.title;
    }
  } catch {
    // Best-effort — see the doc comment above.
  }

  const copy = buildGateNotificationCopy(title);
  const notification = new Notification(copy.title, { body: copy.body });
  notification.onclick = () => {
    window.location.assign(`/tasks/${envelope.taskId}`);
  };
}

export function GateApprovalNotifier({ notifications }: { notifications: NotificationSettings }) {
  // The SSE connection is opened once and outlives every settings change;
  // reading the *latest* toggle through a ref (rather than a `useEffect`
  // dependency that would tear the connection down) is what lets a toggle
  // flipped mid-session take effect on the very next event.
  const notificationsRef = useRef(notifications);
  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  useEffect(() => {
    const cursorGate = createCursorGate(readStoredCursor());
    const source = new EventSource(`/api/events/stream?after=${cursorGate.value}`);

    const onMessage = (event: MessageEvent<string>) => {
      let envelope: StreamEnvelope;
      try {
        envelope = JSON.parse(event.data) as StreamEnvelope;
      } catch {
        // A malformed frame is not worth tearing the stream down for.
        return;
      }

      const isNew = cursorGate.advance(envelope.id);
      persistCursor(cursorGate.value);
      if (!isNew) return;
      if (!isApprovalGateOpened(envelope)) return;

      // Unsupported browsers have no `Notification` global at all — guard
      // before touching `.permission`, which would otherwise throw.
      if (typeof window.Notification === "undefined") return;
      if (
        !canShowBrowserNotifications(notificationsRef.current.browser, Notification.permission)
      ) {
        return;
      }

      void notifyApprovalGate(envelope);
    };

    // Every payload is dispatched under its own event name (see `LiveLog`),
    // so a single `message` handler is not enough — listen on every type.
    source.addEventListener("message", onMessage);
    for (const type of PIPELINE_EVENT_TYPES) {
      source.addEventListener(type, onMessage as EventListener);
    }

    return () => source.close();
  }, []);

  return null;
}
