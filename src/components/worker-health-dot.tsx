"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import type { WorkerHealth } from "@/server/worker/health";

/** How often the nav polls `/api/health` for a live update (§7.4). */
const POLL_MS = 15_000;

const DOT_TONE: Record<WorkerHealth["state"], string> = {
  healthy: "bg-success",
  lagging: "bg-warning",
  stale: "bg-danger",
  never_started: "bg-muted",
};

const STATE_LABEL: Record<WorkerHealth["state"], string> = {
  healthy: "Worker healthy",
  lagging: "Worker lagging",
  stale: "Worker stale",
  never_started: "Worker never started",
};

function title(health: WorkerHealth): string {
  const label = STATE_LABEL[health.state];
  if (health.lagMs === null) return `${label} — no heartbeat recorded yet.`;
  const lagSeconds = Math.round(health.lagMs / 1000);
  const suffix = health.interrupted
    ? ` The worker died mid-stage; restart it to resume task ${health.activeTaskId}.`
    : "";
  return `${label} — last heartbeat ${lagSeconds}s ago.${suffix}`;
}

/**
 * Was a purely decorative dot beside the product name (`nav.tsx`); now
 * reports worker liveness (§7.4) — green/amber/red/grey for
 * healthy/lagging/stale/never_started, with the derived state and lag in the
 * title attribute. `initialHealth` avoids a flash of "never started" on first
 * paint, matching how `initialTheme` is passed into `ThemeSwitch`.
 */
export function WorkerHealthDot({ initialHealth }: { initialHealth: WorkerHealth }) {
  const [health, setHealth] = useState(initialHealth);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/health");
        const data = (await response.json()) as WorkerHealth;
        if (!cancelled) setHealth(data);
      } catch {
        // A failed health fetch says nothing about the worker; leave the
        // last known state showing rather than flip to a misleading one.
      }
    }

    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <span
      className={cn("inline-block size-2 rounded-full", DOT_TONE[health.state])}
      title={title(health)}
      data-health-state={health.state}
      aria-hidden
    />
  );
}
