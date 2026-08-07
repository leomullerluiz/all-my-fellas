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
      <TaskBoard tasks={tasks} capacity={CAPACITY} />
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

  it("shows no checkbox on an on_queue card, but keeps its 'On Queue' count and actions menu", () => {
    renderBoard([
      makeTask({ id: "task_queued", title: "Waiting its turn", status: "on_queue" }),
    ]);

    const onQueueColumn = column("On Queue");
    expect(
      within(onQueueColumn).queryByRole("checkbox", { name: /Waiting its turn/ }),
    ).toBeNull();
    expect(within(onQueueColumn).getByRole("link", { name: "Waiting its turn" })).toBeTruthy();
    expect(within(onQueueColumn).getByRole("button", { name: "Task actions" })).toBeTruthy();
    expect(countIn("On Queue")).toBe("1");
  });
});
