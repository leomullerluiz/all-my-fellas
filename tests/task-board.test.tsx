// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BatchSelectionProvider } from "@/components/batch-start";
import { TaskBoard, type BoardTask } from "@/components/task-board";

/**
 * S2 — the board splits `CREATED`-stage tasks into "Created" and "On Queue"
 * columns by `status`, without double-counting either header.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
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
    // Most fixtures here don't care about execution state — only the "not
    // delivered" and column-split behaviour. Tests that do care (S1's pulse
    // regression, below) override it explicitly.
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
      <TaskBoard tasks={tasks} capacity={CAPACITY} maxJobAttempts={3} now={0} />
    </BatchSelectionProvider>,
  );
}

/** The column `<section>` whose header text is exactly `label`. */
function column(label: string): HTMLElement {
  const header = screen.getByText(label, { selector: "h2" });
  return header.closest("section") as HTMLElement;
}

function countIn(label: string): string {
  return within(column(label)).getByText(/^\d+$/).textContent ?? "";
}

describe("TaskBoard column split", () => {
  it("renders a distinct 'On Queue' column between 'Created' and 'Stakeholder'", () => {
    renderBoard([]);

    const headers = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    const createdIndex = headers.indexOf("Created");
    const onQueueIndex = headers.indexOf("On Queue");
    const stakeholderIndex = headers.indexOf("Stakeholder");

    expect(createdIndex).toBeGreaterThanOrEqual(0);
    expect(onQueueIndex).toBe(createdIndex + 1);
    expect(stakeholderIndex).toBe(onQueueIndex + 1);
  });

  it("puts an on_queue task under 'On Queue', not 'Created'", () => {
    renderBoard([
      makeTask({ id: "task_queued", title: "Waiting its turn", status: "on_queue" }),
    ]);

    expect(within(column("On Queue")).getByText("Waiting its turn")).toBeTruthy();
    expect(within(column("Created")).queryByText("Waiting its turn")).toBeNull();
  });

  it("puts a fresh CREATED/queued task under 'Created', never 'On Queue'", () => {
    renderBoard([
      makeTask({ id: "task_fresh", title: "Never queued", status: "queued" }),
    ]);

    expect(within(column("Created")).getByText("Never queued")).toBeTruthy();
    expect(within(column("On Queue")).queryByText("Never queued")).toBeNull();
  });

  it("shows a started (former queue) task under its pipeline stage, not 'On Queue'", () => {
    renderBoard([
      makeTask({
        id: "task_started",
        title: "Now running",
        currentStage: "STAKEHOLDER_REFINEMENT",
        status: "running",
      }),
    ]);

    expect(within(column("Stakeholder")).getByText("Now running")).toBeTruthy();
    expect(within(column("On Queue")).queryByText("Now running")).toBeNull();
    expect(within(column("Created")).queryByText("Now running")).toBeNull();
  });

  it("threads dependsOn through to the card menu, disabling Start on an incomplete prerequisite", async () => {
    renderBoard([
      makeTask({
        id: "task_blocked",
        title: "Blocked card",
        status: "queued",
        dependsOn: [{ id: "task_prereq", title: "Prereq", status: "queued" }],
      }),
    ]);

    // Radix's trigger opens on `pointerdown`, which `fireEvent.click` never
    // dispatches in jsdom — `userEvent` synthesizes the full pointer sequence.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Task actions" }));

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the 'Created' and 'On Queue' header counts from double-counting either task", () => {
    renderBoard([
      makeTask({ id: "task_a", title: "Created A", status: "queued" }),
      makeTask({ id: "task_b", title: "Created B", status: "queued" }),
      makeTask({ id: "task_c", title: "Queued C", status: "on_queue" }),
    ]);

    expect(countIn("Created")).toBe("2");
    expect(countIn("On Queue")).toBe("1");
  });

  it("shows a checkbox on an on_queue card (S4), alongside its 'On Queue' count and actions menu", () => {
    renderBoard([
      makeTask({ id: "task_queued", title: "Waiting its turn", status: "on_queue" }),
    ]);

    const onQueueColumn = column("On Queue");
    expect(within(onQueueColumn).getByRole("checkbox", { name: /Waiting its turn/ })).toBeTruthy();
    expect(within(onQueueColumn).getByRole("link", { name: "Waiting its turn" })).toBeTruthy();
    expect(within(onQueueColumn).getByRole("button", { name: "Task actions" })).toBeTruthy();
    expect(countIn("On Queue")).toBe("1");
  });
});

/**
 * S1 — every card in "Not delivered" (`REJECTED`/`FAILED`/`CANCELLED`) gets
 * an options menu; every other column's header controls are unaffected.
 */
describe("TaskBoard 'Not delivered' options menu", () => {
  it.each(["REJECTED", "FAILED", "CANCELLED"] as const)(
    "renders a 'Task actions' trigger for a %s card under 'Not delivered'",
    (stage) => {
      renderBoard([
        makeTask({ id: `task_${stage}`, title: `Closed ${stage}`, currentStage: stage, status: stage.toLowerCase() as never }),
      ]);

      const closedColumn = column("Not delivered");
      expect(within(closedColumn).getByText(`Closed ${stage}`)).toBeTruthy();
      expect(within(closedColumn).getByRole("button", { name: "Task actions" })).toBeTruthy();
    },
  );

  it("keeps the title link independently clickable, as a sibling of the trigger", () => {
    renderBoard([
      makeTask({ id: "task_rejected", title: "Rejected one", currentStage: "REJECTED", status: "rejected" }),
    ]);

    const closedColumn = column("Not delivered");
    const titleLink = within(closedColumn).getByRole("link", { name: "Rejected one" });
    const trigger = within(closedColumn).getByRole("button", { name: "Task actions" });
    expect(titleLink).toBeTruthy();
    expect(trigger.closest("a")).toBeNull();
    expect(titleLink.closest("button")).toBeNull();
  });

  it("opens 'Move to Created' from a closed card's menu", async () => {
    renderBoard([
      makeTask({ id: "task_failed", title: "Failed one", currentStage: "FAILED", status: "failed" }),
    ]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Task actions" }));

    expect(screen.getByRole("menuitem", { name: "Move to Created" })).toBeTruthy();
  });

  it("does not add the closed-column menu to running, gate, or queued indicators", () => {
    renderBoard([
      makeTask({
        id: "task_running",
        title: "Running one",
        currentStage: "DEVELOPMENT",
        status: "running",
        execution: { kind: "in_flight", job: "agent" },
      }),
      makeTask({ id: "task_gate", title: "Gate one", currentStage: "PLAN_GATE", status: "awaiting_gate" }),
    ]);

    expect(screen.queryByRole("button", { name: "Task actions" })).toBeNull();
    expect(screen.getByTitle("An agent is running")).toBeTruthy();
    expect(screen.getByTitle("Waiting for your approval")).toBeTruthy();
  });
});

/**
 * S1 — the pulse means exactly "the worker has this task's job claimed right
 * now", not "this task is admitted". `renderBoard` above defaults `capacity`
 * to `{ limit: 5, ... }`, so queue wording is not suppressed unless a test
 * asks for it explicitly.
 */
describe("TaskBoard execution indicator", () => {
  function runningTask(overrides: Partial<BoardTask> = {}): BoardTask {
    return makeTask({ status: "running", currentStage: "DEVELOPMENT", ...overrides });
  }

  it("pulses only the one in-flight card among several admitted tasks", () => {
    renderBoard([
      runningTask({ id: "task_flight", title: "In flight", execution: { kind: "in_flight", job: "agent" } }),
      runningTask({
        id: "task_wait_1",
        title: "Waiting one",
        execution: { kind: "waiting_for_worker", position: 1, depth: 2 },
      }),
      runningTask({
        id: "task_wait_2",
        title: "Waiting two",
        execution: { kind: "waiting_for_worker", position: 2, depth: 2 },
      }),
    ]);

    // Exactly one pulsing dot: `PulseDot` renders a `<motion.span>` — the only
    // element in this render with the "An agent is running" title.
    expect(screen.getAllByTitle("An agent is running")).toHaveLength(1);
    expect(screen.getByTitle("Queued for the worker — 1st of 2")).toBeTruthy();
    expect(screen.getByTitle("Queued for the worker — 2nd of 2")).toBeTruthy();
  });

  it("never renders 'An agent is running' for a waiting_for_worker card", () => {
    renderBoard([
      runningTask({
        id: "task_wait",
        title: "Waiting",
        execution: { kind: "waiting_for_worker", position: 1, depth: 3 },
      }),
    ]);

    expect(screen.queryByText("An agent is running")).toBeNull();
    expect(screen.queryByTitle("An agent is running")).toBeNull();
  });

  it("shows retry-backoff wording with the attempt count, not a pulse", () => {
    renderBoard([
      runningTask({
        id: "task_backoff",
        title: "Backing off",
        execution: { kind: "retry_backoff", retryAt: Date.now() + 14_000, attempt: 2 },
      }),
    ]);

    expect(screen.queryByTitle("An agent is running")).toBeNull();
    const dot = screen.getByTitle(/Stage failed; retrying in \d+s \(attempt 2 of 3\)/);
    expect(dot).toBeTruthy();
  });

  it("shows settling wording for an admitted task with nothing queued", () => {
    renderBoard([
      runningTask({ id: "task_settling", title: "Stranded", execution: { kind: "settling" } }),
    ]);

    expect(screen.getByTitle("Nothing is queued for this task")).toBeTruthy();
    expect(screen.queryByTitle("An agent is running")).toBeNull();
  });

  it("suppresses queue-position wording entirely when maxParallelTasks is 1", () => {
    const waitingTask = runningTask({
      id: "task_wait",
      title: "Momentarily waiting",
      execution: { kind: "waiting_for_worker", position: 1, depth: 1 },
    });
    render(
      <BatchSelectionProvider tasks={[{ id: waitingTask.id, status: waitingTask.status, archivedAt: null }]}>
        <TaskBoard
          tasks={[waitingTask]}
          capacity={{ slotAvailable: false, limit: 1, blocking: [] }}
          maxJobAttempts={3}
          now={0}
        />
      </BatchSelectionProvider>,
    );

    expect(screen.queryByText(/Queued for the worker/)).toBeNull();
    expect(screen.queryByTitle("An agent is running")).toBeNull();
  });
});
