import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * stories.md S1 — say when the pull request was not opened, rather than
 * collapsing `createChangeRequest`'s `{status:"created"|"manual"}` union
 * into one `pr_url` write.
 *
 * `recordDeliveryOutcome` is exercised directly for the "created" branch
 * (no provider API is reachable from a test), and `retryPullRequestCreation`
 * is exercised end to end for the "manual" branch: the `generic` provider's
 * `createChangeRequest` always throws, which is exactly the "API call
 * failed" case this story has to survive without failing the task.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-delivery-outcome-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");
process.env.TEST_GIT_TOKEN = "fake-token";

type Service = typeof import("@/server/tasks/service");
type Execute = typeof import("@/server/pipeline/execute");

let service: Service;
let execute: Execute;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  execute = await import("@/server/pipeline/execute");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEST_GIT_TOKEN;
});

function newTask(overrides: Partial<Parameters<Service["updateTask"]>[1]> = {}) {
  const repo = service.createRepo({
    name: "acme/delivery-outcome",
    url: "https://git.example.com/acme/delivery-outcome",
    provider: "generic",
    defaultBranch: "main",
    credentialRef: "TEST_GIT_TOKEN",
  });
  const task = service.createTask({
    repoId: repo.id,
    title: "Delivery outcome task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });
  service.updateTask(task.id, {
    branchName: "pipeline/task-delivery-outcome",
    ...overrides,
  });
  return { repo, task: service.getTaskWithRepo(task.id)! };
}

describe("recordDeliveryOutcome", () => {
  it("records a created outcome, including the PR number ChangeRequestRef.id carried", () => {
    const { task } = newTask();

    execute.recordDeliveryOutcome(task.id, {
      status: "created",
      url: "https://git.example.com/acme/delivery-outcome/pulls/42",
      noun: "pull request",
      number: 42,
    });

    const updated = service.getTask(task.id)!;
    expect(updated.deliveryOutcome).toBe("created");
    expect(updated.deliveryReason).toBeNull();
    expect(updated.prNumber).toBe(42);
    expect(updated.prState).toBe("open");
    expect(updated.prUrl).toBe("https://git.example.com/acme/delivery-outcome/pulls/42");
  });

  it("records a manual outcome, leaving pr_number null", () => {
    const { task } = newTask();

    execute.recordDeliveryOutcome(task.id, {
      status: "manual",
      url: "https://git.example.com/acme/delivery-outcome/compare/main...pipeline/task-delivery-outcome",
      reason: "No credential is configured for this repository.",
      noun: "pull request",
    });

    const updated = service.getTask(task.id)!;
    expect(updated.deliveryOutcome).toBe("manual");
    expect(updated.deliveryReason).toBe("No credential is configured for this repository.");
    expect(updated.prNumber).toBeNull();
    expect(updated.prState).toBeNull();
    expect(updated.prUrl).toContain("/compare/");
  });
});

describe("retryPullRequestCreation", () => {
  afterEach(() => {
    // Nothing to clean between cases beyond what `newTask` creates fresh.
  });

  it("re-runs only the change-request call, without pushing or creating a new stage run", async () => {
    const { task } = newTask({
      deliveryOutcome: "manual",
      deliveryReason: "No credential is configured for this repository.",
      prUrl: "https://git.example.com/acme/delivery-outcome/compare/main...pipeline/task-delivery-outcome",
    });
    expect(service.listStageRuns(task.id)).toHaveLength(0);

    // `generic` has no change-request API and always throws — retrying still
    // must not fail the caller, and must produce another honest "manual"
    // outcome rather than crashing.
    const change = await execute.retryPullRequestCreation(task.id);

    // The caller (the API route, then the "Try again" button) needs this to
    // tell a genuine `created` retry from a repeated `manual` one — a 200
    // response alone does not say which happened. See the code-review
    // finding this return value was added to fix.
    expect(change.status).toBe("manual");

    const updated = service.getTask(task.id)!;
    expect(updated.deliveryOutcome).toBe("manual");
    expect(updated.deliveryReason).toContain("pipeline/task-delivery-outcome");
    expect(updated.prNumber).toBeNull();

    // No workspace ever existed for this task, and no `DELIVERY` stage run
    // was created — so if a push or a new stage run had been attempted, it
    // would have thrown or left a row behind. Neither happened.
    expect(service.listStageRuns(task.id)).toHaveLength(0);
  });

  it("refuses to retry a task whose delivery already created a change request", async () => {
    const { task } = newTask({
      deliveryOutcome: "created",
      prNumber: 7,
      prState: "open",
      prUrl: "https://git.example.com/acme/delivery-outcome/pulls/7",
    });

    await expect(execute.retryPullRequestCreation(task.id)).rejects.toThrow(
      execute.ChangeRequestNotRetryableError,
    );
  });

  it("refuses to retry a task with no pushed branch", async () => {
    const { task } = newTask({ branchName: null, deliveryOutcome: "manual" });

    await expect(execute.retryPullRequestCreation(task.id)).rejects.toThrow(
      execute.ChangeRequestNotRetryableError,
    );
  });
});
