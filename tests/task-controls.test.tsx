// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskControls } from "@/components/task-actions";

// `TaskControls` only calls `router.push`/`router.refresh` after a fetch
// resolves; these render-only tests never trigger that, so a stub suffices.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

describe("TaskControls start button vs. capacity", () => {
  it("enables Start for a CREATED task when the only other active task is awaiting_gate", () => {
    render(
      <TaskControls
        taskId="task_1"
        taskTitle="New task"
        status="queued"
        notStarted
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    const startButton = screen.getByRole("button", { name: "Start" });
    expect(startButton.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/Limit of/)).toBeNull();
  });

  it("disables Start and names the running task when capacity is exhausted", () => {
    render(
      <TaskControls
        taskId="task_2"
        taskTitle="New task"
        status="queued"
        notStarted
        capacity={{
          slotAvailable: false,
          limit: 1,
          blocking: [{ title: "Running task" }],
        }}
      />,
    );

    const startButton = screen.getByRole("button", { name: "Start" });
    expect(startButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Limit of 1 task in progress reached/)).toBeTruthy();
    expect(screen.getByText(/Running task is still running\./)).toBeTruthy();
  });
});

describe("TaskControls gate_queued status (S2)", () => {
  it("shows the queued reason and Cancel, with no error state", () => {
    render(
      <TaskControls
        taskId="task_3"
        taskTitle="Approved task"
        status="gate_queued"
        notStarted={false}
        capacity={{
          slotAvailable: false,
          limit: 1,
          blocking: [{ title: "Running task" }],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel task" })).toBeTruthy();
    expect(screen.getByText(/Limit of 1 task in progress reached/)).toBeTruthy();
    expect(screen.getByText(/Running task is still running\./)).toBeTruthy();
    // Not an error state: the decision was accepted, not refused.
    expect(screen.queryByText("Could not cancel the task.")).toBeNull();
  });
});
