// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BatchSelectionProvider, BatchStartButton } from "@/components/batch-start";
import { TaskBoard, type BoardTask } from "@/components/task-board";
import type { QuotaStatus } from "@/server/usage/quota";

// Both components only call `router.refresh()` after a successful fetch; a
// stub is enough, matching `tests/task-card-menu.test.tsx`.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REPO = {
  id: "repo_1",
  name: "acme/app",
  provider: "github" as const,
  url: "https://github.com/acme/app",
  defaultBranch: "main",
  credentialRef: null,
  credentialUsername: null,
  apiBaseUrl: null,
  context: null,
  verifyInstall: null,
  verifyBuild: null,
  verifyTest: null,
  verifyLint: null,
  verifyTimeoutSeconds: 600,
  createdAt: 0,
};

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task_1",
    repoId: REPO.id,
    title: "A task",
    description: "Some description",
    status: "queued",
    currentStage: "CREATED",
    priority: "medium",
    difficulty: null,
    criticality: null,
    requireHumanCodeReview: false,
    branchName: null,
    customBranchName: null,
    prUrl: null,
    deliveryOutcome: null,
    deliveryReason: null,
    prNumber: null,
    prState: null,
    workspacePath: null,
    failureReason: null,
    failedStage: null,
    failureKind: null,
    reworkBudgetGrant: 0,
    maxCostUsd: null,
    archivedAt: null,
    paused: false,
    createdAt: 0,
    updatedAt: 0,
    repo: REPO,
    costUsd: 0,
    dependsOn: [],
    execution: { kind: "idle" },
    runningStageStartedAt: null,
    queuePosition: null,
    ...overrides,
  };
}

const CAPACITY = { slotAvailable: true, limit: 5, blocking: [] };

function renderBoard(tasks: BoardTask[]) {
  return render(
    <BatchSelectionProvider tasks={tasks.map((t) => ({ id: t.id, status: t.status, archivedAt: t.archivedAt }))}>
      <BatchStartButton />
      <TaskBoard tasks={tasks} capacity={CAPACITY} maxJobAttempts={3} now={0} />
    </BatchSelectionProvider>,
  );
}

describe("checkbox visibility", () => {
  it("renders a checkbox on every card, regardless of status (S4)", () => {
    renderBoard([
      makeTask({ id: "task_created", title: "Not started", currentStage: "CREATED" }),
      makeTask({
        id: "task_running",
        title: "Running",
        currentStage: "DEVELOPMENT",
        status: "running",
      }),
      makeTask({
        id: "task_waiting",
        title: "Waiting",
        currentStage: "PLAN_GATE",
        status: "awaiting_gate",
      }),
      makeTask({
        id: "task_done",
        title: "Done",
        currentStage: "COMPLETED",
        status: "completed",
      }),
      makeTask({
        id: "task_on_queue",
        title: "Parked",
        currentStage: "CREATED",
        status: "on_queue",
      }),
    ]);

    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    expect(screen.getByRole("checkbox", { name: /Not started/ })).toBeTruthy();
  });

  it("shows a checkbox on an on_queue card alongside its title link and actions menu", () => {
    renderBoard([
      makeTask({
        id: "task_on_queue",
        title: "Parked",
        currentStage: "CREATED",
        status: "on_queue",
      }),
    ]);

    expect(screen.getByRole("checkbox", { name: /Parked/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Parked" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Task actions" })).toBeTruthy();
  });
});

describe("BatchStartButton enable/disable and count", () => {
  it("is disabled with zero selected and enables with a count once checked", () => {
    renderBoard([
      makeTask({ id: "task_a", title: "Task A" }),
      makeTask({ id: "task_b", title: "Task B" }),
    ]);

    const button = screen.getByRole("button", { name: "Start selected" });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));

    const updated = screen.getByRole("button", { name: "Start selected (1)" });
    expect(updated.hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: /Task B/ }));
    expect(screen.getByRole("button", { name: "Start selected (2)" })).toBeTruthy();

    // Unchecking drops the count back down.
    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();
  });
});

describe("BatchStartButton outcome summary", () => {
  it("shows a partial-start summary distinguishing a genuine failure from an on-queue task", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { taskId: "task_a", title: "Task A", started: true, queued: false, reason: null },
          {
            taskId: "task_b",
            title: "Task B",
            started: false,
            queued: true,
            reason: "Limit of 1 task in progress reached — Task A is still running.",
          },
          {
            taskId: "task_c",
            title: "Task C",
            started: false,
            queued: false,
            reason: "This task has already been started.",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBoard([
      makeTask({ id: "task_a", title: "Task A" }),
      makeTask({ id: "task_b", title: "Task B" }),
      makeTask({ id: "task_c", title: "Task C" }),
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Task B/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Task C/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start selected (3)" }));

    await waitFor(() =>
      expect(
        screen.getByText("1 of 3 started, 1 on queue — some tasks could not be started"),
      ).toBeTruthy(),
    );
    // The on-queue task is not reported with the capacity-refusal reason as a
    // failure — it will start automatically, so the copy says so instead.
    expect(screen.getByText("Task B: on queue, will start automatically")).toBeTruthy();
    // A genuine failure still shows the server's reason text.
    expect(screen.getByText(/Task C: This task has already been started\./)).toBeTruthy();

    // Selection is cleared once the batch completes.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/batch-start",
      expect.objectContaining({ method: "POST" }),
    );
    const button = screen.getByRole("button", { name: "Start selected" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the selection and shows an inline error when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    renderBoard([makeTask({ id: "task_a", title: "Task A" })]);

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start selected (1)" }));

    await waitFor(() =>
      expect(screen.getByText("The request failed. Is the server still running?")).toBeTruthy(),
    );

    // The selection survives the failure: the checkbox is still checked and
    // the button still shows the count.
    expect(screen.getByRole("checkbox", { name: /Task A/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();
  });
});

describe("BatchStartButton quota warning (S4 — beside every Start affordance)", () => {
  const QUOTA_EXCEEDED: QuotaStatus = {
    provider: "chatgpt",
    state: "exceeded",
    cadence: "monthly",
    limitUsd: 10,
    usedUsd: 12,
    remainingUsd: 0,
    resetAt: 0,
  };

  it("shows no quota note when nothing is configured", () => {
    renderBoard([]);

    expect(screen.queryByText(/quota/i)).toBeNull();
  });

  it("shows an exceeded note beside the button without disabling it", () => {
    const task = makeTask({ id: "task_a", title: "Task A" });
    render(
      <BatchSelectionProvider
        tasks={[{ id: task.id, status: task.status, archivedAt: task.archivedAt }]}
      >
        <BatchStartButton quotas={[QUOTA_EXCEEDED]} />
        <TaskBoard tasks={[task]} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByText("ChatGPT (OpenAI) quota exceeded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    expect(screen.getByRole("button", { name: "Start selected (1)" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("selection survival across a board refresh (S4 §7.1)", () => {
  it("keeps A and B selected when only unrelated task C changes stage — fails against the old boardVersion digest", () => {
    const a = makeTask({ id: "task_a", title: "Task A" });
    const b = makeTask({ id: "task_b", title: "Task B" });
    const c = makeTask({ id: "task_c", title: "Task C" });

    const { rerender } = render(
      <BatchSelectionProvider tasks={[a, b, c].map((t) => ({ id: t.id, status: t.status, archivedAt: t.archivedAt }))}>
        <BatchStartButton />
        <TaskBoard tasks={[a, b, c]} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Task B/ }));
    expect(screen.getByRole("button", { name: "Start selected (2)" })).toBeTruthy();

    // Only task C changes stage — A and B are untouched.
    const cStarted = makeTask({
      id: "task_c",
      title: "Task C",
      currentStage: "STAKEHOLDER_REFINEMENT",
      status: "running",
    });
    rerender(
      <BatchSelectionProvider
        tasks={[a, b, cStarted].map((t) => ({ id: t.id, status: t.status, archivedAt: t.archivedAt }))}
      >
        <BatchStartButton />
        <TaskBoard tasks={[a, b, cStarted]} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByRole("checkbox", { name: /Task A/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: /Task B/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Start selected (2)" })).toBeTruthy();
  });

  it("drops only the selected id that becomes ineligible for every verb, keeping the rest", () => {
    const a = makeTask({ id: "task_a", title: "Task A", status: "queued" });
    const b = makeTask({ id: "task_b", title: "Task B", status: "queued" });

    const { rerender } = render(
      <BatchSelectionProvider tasks={[a, b].map((t) => ({ id: t.id, status: t.status, archivedAt: t.archivedAt }))}>
        <BatchStartButton />
        <TaskBoard tasks={[a, b]} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Task B/ }));

    // Task A completes (terminal, already archived) — ineligible for every
    // batch verb (start/archive/cancel). Task B is untouched.
    const aArchived = makeTask({
      id: "task_a",
      title: "Task A",
      currentStage: "COMPLETED",
      status: "completed",
      archivedAt: Date.now(),
    });
    rerender(
      <BatchSelectionProvider
        tasks={[aArchived, b].map((t) => ({ id: t.id, status: t.status, archivedAt: t.archivedAt }))}
      >
        <BatchStartButton />
        <TaskBoard tasks={[aArchived, b]} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByRole("checkbox", { name: /Task B/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();
  });

  it("keeps the selection across a re-render where nothing relevant changed (e.g. an idle poll)", () => {
    const tasks = [makeTask({ id: "task_a", title: "Task A" })];
    const asRecord = tasks.map((t) => ({ id: t.id, status: t.status, archivedAt: t.archivedAt }));

    const { rerender } = render(
      <BatchSelectionProvider tasks={asRecord}>
        <BatchStartButton />
        <TaskBoard tasks={tasks} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();

    rerender(
      <BatchSelectionProvider tasks={asRecord}>
        <BatchStartButton />
        <TaskBoard tasks={tasks} capacity={CAPACITY} maxJobAttempts={3} now={0} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByRole("checkbox", { name: /Task A/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();
  });
});
