// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BatchSelectionProvider, BatchStartButton } from "@/components/batch-start";
import { TaskBoard, type BoardTask } from "@/components/task-board";

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
    prUrl: null,
    workspacePath: null,
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
    repo: REPO,
    costUsd: 0,
    dependsOn: [],
    ...overrides,
  };
}

const CAPACITY = { slotAvailable: true, limit: 5, blocking: [] };

function renderBoard(tasks: BoardTask[]) {
  return render(
    <BatchSelectionProvider>
      <BatchStartButton />
      <TaskBoard tasks={tasks} capacity={CAPACITY} />
    </BatchSelectionProvider>,
  );
}

describe("checkbox visibility", () => {
  it("renders a checkbox only on CREATED cards", () => {
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

    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: /Not started/ })).toBeTruthy();
  });

  it("shows no checkbox on an on_queue card but keeps its title link and actions menu", () => {
    renderBoard([
      makeTask({
        id: "task_on_queue",
        title: "Parked",
        currentStage: "CREATED",
        status: "on_queue",
      }),
    ]);

    expect(screen.queryByRole("checkbox", { name: /Parked/ })).toBeNull();
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

describe("selection reset when the board reloads", () => {
  it("clears a checked selection once boardVersion reflects a task's state changing", () => {
    const created = makeTask({ id: "task_a", title: "Task A" });

    const { rerender } = render(
      <BatchSelectionProvider boardVersion="task_a:CREATED:queued">
        <BatchStartButton />
        <TaskBoard tasks={[created]} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();

    // Simulates the dashboard server component re-rendering with fresh task
    // data (a fresh page load, `AutoRefresh`'s poll noticing the task
    // started, or `TaskCardMenu.call()`'s refresh after an unrelated
    // action) — `page.tsx` recomputes `boardVersion` from `id:stage:status`
    // on every request, so it changes here because the task is no longer
    // `CREATED`/`queued`.
    const started = makeTask({
      id: "task_a",
      title: "Task A",
      currentStage: "STAKEHOLDER_REFINEMENT",
      status: "running",
    });
    rerender(
      <BatchSelectionProvider boardVersion="task_a:STAKEHOLDER_REFINEMENT:running">
        <BatchStartButton />
        <TaskBoard tasks={[started]} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    expect(screen.queryByRole("checkbox", { name: /Task A/ })).toBeNull();
    const button = screen.getByRole("button", { name: "Start selected" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the selection across a re-render where boardVersion is unchanged (e.g. an idle poll)", () => {
    const tasks = [makeTask({ id: "task_a", title: "Task A" })];

    const { rerender } = render(
      <BatchSelectionProvider boardVersion="task_a:CREATED:queued">
        <BatchStartButton />
        <TaskBoard tasks={tasks} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Task A/ }));
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();

    rerender(
      <BatchSelectionProvider boardVersion="task_a:CREATED:queued">
        <BatchStartButton />
        <TaskBoard tasks={tasks} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByRole("checkbox", { name: /Task A/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Start selected (1)" })).toBeTruthy();
  });

  it("hides then reshows the checkbox as status flips between on_queue and queued", () => {
    const queued = makeTask({ id: "task_a", title: "Task A", status: "queued" });

    const { rerender } = render(
      <BatchSelectionProvider boardVersion="task_a:CREATED:queued">
        <BatchStartButton />
        <TaskBoard tasks={[queued]} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByRole("checkbox", { name: /Task A/ })).toBeTruthy();

    // Loses the capacity race and gets parked on queue: same stage, new status.
    const onQueue = makeTask({ id: "task_a", title: "Task A", status: "on_queue" });
    rerender(
      <BatchSelectionProvider boardVersion="task_a:CREATED:on_queue">
        <BatchStartButton />
        <TaskBoard tasks={[onQueue]} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    expect(screen.queryByRole("checkbox", { name: /Task A/ })).toBeNull();

    // The orchestrator promotes it back off the queue: checkbox reappears.
    rerender(
      <BatchSelectionProvider boardVersion="task_a:CREATED:queued">
        <BatchStartButton />
        <TaskBoard tasks={[queued]} capacity={CAPACITY} />
      </BatchSelectionProvider>,
    );

    expect(screen.getByRole("checkbox", { name: /Task A/ })).toBeTruthy();
  });
});
