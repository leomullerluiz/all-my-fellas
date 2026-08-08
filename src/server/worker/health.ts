import type { WorkerStatusRow } from "../db/schema";
import { getWorkerStatus } from "./status";

/**
 * Derived worker liveness (§7.3). A stale heartbeat is more informative than
 * an absent one, so this is a small state machine over `heartbeat_at`'s age
 * rather than a boolean "is it there".
 */

/** The worker's own tick interval — kept in sync with `worker/index.ts`'s `TICK_MS`. */
export const WORKER_TICK_MS = 1_000;

export type HealthState = "never_started" | "healthy" | "lagging" | "stale";

export type WorkerHealth = {
  state: HealthState;
  /** Milliseconds since the last heartbeat, or `null` when no row exists. */
  lagMs: number | null;
  activeTaskId: string | null;
  /**
   * A `stale` worker holding an active task died mid-stage (§7.3): the task
   * will sit at `running` until the worker restarts and
   * `requeueOrphanedJobs` returns its claimed job to `pending`. `false` for
   * every other state, including `stale` with no active task.
   */
  interrupted: boolean;
};

/** Derives {@link WorkerHealth} from a row (or its absence). Pure, given `now`, for testability. */
export function deriveWorkerHealth(row: WorkerStatusRow | null, now: number = Date.now()): WorkerHealth {
  if (!row) {
    return { state: "never_started", lagMs: null, activeTaskId: null, interrupted: false };
  }

  const lagMs = now - row.heartbeatAt;
  const state: HealthState = lagMs <= 3 * WORKER_TICK_MS ? "healthy" : lagMs <= 60_000 ? "lagging" : "stale";

  return {
    state,
    lagMs,
    activeTaskId: row.activeTaskId,
    interrupted: state === "stale" && row.activeTaskId !== null,
  };
}

/** Reads the current row and derives its health in one call — what API routes want. */
export function resolveWorkerHealth(now: number = Date.now()): WorkerHealth {
  return deriveWorkerHealth(getWorkerStatus(), now);
}
