import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S4/§6.5 — `handleJobFailure` must not treat a cancelled stage run as a
 * failure: no `stage_failed` event, no second `advanceTask` call (the task
 * already reached `CANCELLED` via `cancelTask` before the abort landed), and
 * the job itself is still marked failed so it is not retried. Split out of
 * `worker/index.ts` into `worker/job-failure.ts` specifically so this does
 * not have to import the worker entrypoint, which starts the real polling
 * loop unconditionally on import.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-failure-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

type Service = typeof import("@/server/tasks/service");
type Orchestrator = typeof import("@/server/pipeline/orchestrator");
type EventsStore = typeof import("@/server/events/store");
type JobFailure = typeof import("@/worker/job-failure");

let service: Service;
let orchestrator: Orchestrator;
let eventsStore: EventsStore;
let jobFailure: JobFailure;
let repoId: string;
let repoCounter = 0;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  orchestrator = await import("@/server/pipeline/orchestrator");
  eventsStore = await import("@/server/events/store");
  jobFailure = await import("@/worker/job-failure");

  const settings = await import("@/server/settings/store");
  settings.updateSettings({ maxParallelTasks: 99 });

  repoId = service.createRepo({
    name: "acme/job-failure",
    url: "https://github.com/acme/job-failure",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newRunningStakeholderRun() {
  repoCounter += 1;
  const task = service.createTask({
    repoId,
    title: `Job failure task ${repoCounter}`,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  orchestrator.startTask(task.id);
  const run = service.listStageRuns(task.id).find((candidate) => candidate.stage === "STAKEHOLDER_REFINEMENT")!;
  return { task, run };
}

function fakeJobRow(taskId: string, stageRunId: string, attempts = 3): import("@/server/db/schema").JobRow {
  return {
    id: "job_fake_1",
    taskId,
    kind: "run_stage",
    payloadJson: JSON.stringify({ stageRunId }),
    runAfter: 0,
    status: "claimed",
    attempts,
    lastError: null,
    createdAt: 0,
  };
}

const noopLog = vi.fn();

describe("handleJobFailure — a cancelled run is not treated as a failure (S4)", () => {
  it("does not append stage_failed or re-advance a task whose run is already 'cancelled'", async () => {
    const { task, run } = newRunningStakeholderRun();

    // Simulate what `execute.ts` already did before throwing: mark the run
    // cancelled with its partial cost, then drive the task to CANCELLED via
    // the same path `cancelTask` uses.
    service.markStageRunStatus(run.id, "cancelled", { error: "aborted" });
    orchestrator.cancelTask(task.id);

    const eventsBefore = eventsStore.readEvents(task.id).length;

    jobFailure.handleJobFailure(fakeJobRow(task.id, run.id), new Error("aborted"), noopLog);

    const taskAfter = service.getTask(task.id)!;
    expect(taskAfter.status).toBe("cancelled");

    const eventsAfter = eventsStore.readEvents(task.id);
    expect(eventsAfter.length).toBe(eventsBefore);
    expect(eventsAfter.some((event) => event.type === "stage_failed")).toBe(false);
  });

  it("still fails the task normally when the run is not cancelled", async () => {
    const { task, run } = newRunningStakeholderRun();

    jobFailure.handleJobFailure(fakeJobRow(task.id, run.id, 3), new Error("a real crash"), noopLog);

    const taskAfter = service.getTask(task.id)!;
    expect(taskAfter.status).toBe("failed");

    const events = eventsStore.readEvents(task.id);
    expect(events.some((event) => event.type === "stage_failed")).toBe(true);
  });
});
