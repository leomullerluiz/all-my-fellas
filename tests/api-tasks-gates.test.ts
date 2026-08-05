import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `POST /api/tasks/:id/gates/:gate` — route-level tests for the
 * approval-queue behaviour (S1): a `run`-resolving decision made at capacity
 * is accepted and queued, not refused. Follows the fixture and
 * request-building pattern in `tests/api-tasks-batch-start.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-gates-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let settings: typeof import("@/server/settings/store");
let orchestrator: typeof import("@/server/pipeline/orchestrator");
let gateRoute: typeof import("@/app/api/tasks/[id]/gates/[gate]/route");
let taskRoute: typeof import("@/app/api/tasks/[id]/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  settings = await import("@/server/settings/store");
  orchestrator = await import("@/server/pipeline/orchestrator");
  gateRoute = await import("@/app/api/tasks/[id]/gates/[gate]/route");
  taskRoute = await import("@/app/api/tasks/[id]/route");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const task of service.listTasks()) service.deleteTask(task.id);
  settings.updateSettings({ maxParallelTasks: 1 });
});

function create(title: string) {
  return service.createTask({
    repoId,
    title,
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
}

function decide(taskId: string, gate: string, decision: string, comment?: string) {
  return gateRoute.POST(
    new Request(`http://test/api/tasks/${taskId}/gates/${gate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, comment }),
    }),
    { params: Promise.resolve({ id: taskId, gate }) },
  );
}

async function getTaskDetail(taskId: string) {
  const response = await taskRoute.GET(new Request("http://test"), {
    params: Promise.resolve({ id: taskId }),
  });
  const payload = (await response.json()) as { task: { status: string; currentStage: string } };
  return payload.task;
}

describe("POST /api/tasks/:id/gates/:gate at capacity", () => {
  it("returns 200 with queued:true instead of a 409 CapacityError", async () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const blocker = create("Blocker");
    orchestrator.startTask(blocker.id);

    const response = await decide(gated.id, "plan_gate", "approve");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { transition: unknown; queued: boolean };
    expect(payload.queued).toBe(true);
    expect(payload.transition).toMatchObject({ type: "run" });
  });

  it("persists the approval and event, and reports the gate_queued status via GET", async () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const blocker = create("Blocker");
    orchestrator.startTask(blocker.id);

    await decide(gated.id, "plan_gate", "approve");

    const body = await getTaskDetail(gated.id);
    expect(body.status).toBe("gate_queued");
    expect(body.currentStage).toBe("PLAN_GATE");

    expect(orchestrator.approvalHistory(gated.id)).toHaveLength(1);
    expect(orchestrator.approvalHistory(gated.id)[0]).toMatchObject({
      gate: "PLAN_GATE",
      decision: "approve",
    });
  });

  it("resumes automatically once the blocking task finishes, with no further request", async () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const blocker = create("Blocker");
    orchestrator.startTask(blocker.id);

    await decide(gated.id, "plan_gate", "approve");
    expect(service.getTask(gated.id)!.status).toBe("gate_queued");

    orchestrator.cancelTask(blocker.id);

    expect(service.getTask(gated.id)!.status).toBe("running");
  });

  it("still returns 200 with queued:false when a slot is free", async () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const response = await decide(gated.id, "plan_gate", "approve");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { queued: boolean };
    expect(payload.queued).toBe(false);
    expect(service.getTask(gated.id)!.status).toBe("running");
  });

  it("leaves reject unaffected by capacity: still terminal, no queueing", async () => {
    const gated = create("Gated");
    orchestrator.startTask(gated.id);
    service.setTaskStage(gated.id, "PLAN_GATE");

    const blocker = create("Blocker");
    orchestrator.startTask(blocker.id);

    const response = await decide(gated.id, "plan_gate", "reject");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { queued: boolean };
    expect(payload.queued).toBe(false);
    expect(service.getTask(gated.id)!.status).toBe("rejected");
  });

  it("resolves exactly one of two concurrent gate approvals into the last slot", async () => {
    // Two independently gated tasks, neither holding a slot, competing for
    // the single free one — mirrors two browser tabs approving at once.
    const first = create("First gated");
    orchestrator.startTask(first.id);
    service.setTaskStage(first.id, "PLAN_GATE");

    const second = create("Second gated");
    orchestrator.startTask(second.id);
    service.setTaskStage(second.id, "PLAN_GATE");

    const [firstResponse, secondResponse] = await Promise.all([
      decide(first.id, "plan_gate", "approve"),
      decide(second.id, "plan_gate", "approve"),
    ]);

    const payloads = (await Promise.all([firstResponse.json(), secondResponse.json()])) as Array<{
      queued: boolean;
    }>;
    expect(payloads.filter((p) => !p.queued)).toHaveLength(1);
    expect(payloads.filter((p) => p.queued)).toHaveLength(1);

    const statuses = [service.getTask(first.id)!.status, service.getTask(second.id)!.status];
    expect(statuses.filter((s) => s === "running")).toHaveLength(1);
    expect(statuses.filter((s) => s === "gate_queued")).toHaveLength(1);
  });
});
