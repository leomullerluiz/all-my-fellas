import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { type WorkerStatusRow, workerStatus } from "../db/schema";

/**
 * Read/write access to the single-row worker heartbeat (§7.2). The row's
 * primary key is always `"worker"` — there is exactly one worker process in
 * this product's current design (§7.5 explains why concurrency, if it ever
 * lands, needs this to grow to one row per in-flight job rather than reusing
 * this shape as-is).
 */

const WORKER_STATUS_ID = "worker";

export function getWorkerStatus(): WorkerStatusRow | null {
  return db.select().from(workerStatus).where(eq(workerStatus.id, WORKER_STATUS_ID)).get() ?? null;
}

/** Called once at worker startup, before the polling loop begins. */
export function recordWorkerStarted(input: { pid: number; version: string | null; now?: number }): void {
  const now = input.now ?? Date.now();
  db.insert(workerStatus)
    .values({
      id: WORKER_STATUS_ID,
      startedAt: now,
      heartbeatAt: now,
      pid: input.pid,
      version: input.version,
      activeJobId: null,
      activeTaskId: null,
    })
    .onConflictDoUpdate({
      target: workerStatus.id,
      set: {
        startedAt: now,
        heartbeatAt: now,
        pid: input.pid,
        version: input.version,
        activeJobId: null,
        activeTaskId: null,
      },
    })
    .run();
}

/**
 * Called on every tick, and on the same interval that drives the cancel-poll
 * (§6.3/§7.2) while a job is in flight — the tick loop itself is blocked
 * inside `await handleJob` for the whole duration of an agent session, so a
 * heartbeat written only between ticks would go stale during exactly the
 * moment it matters most.
 */
export function recordWorkerHeartbeat(input: {
  activeJobId: string | null;
  activeTaskId: string | null;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  db.update(workerStatus)
    .set({ heartbeatAt: now, activeJobId: input.activeJobId, activeTaskId: input.activeTaskId })
    .where(eq(workerStatus.id, WORKER_STATUS_ID))
    .run();
}
