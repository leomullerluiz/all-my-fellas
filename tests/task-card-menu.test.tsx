// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskCardMenu } from "@/components/task-card-menu";

// `next/navigation`'s `useRouter` requires a router context outside the app
// tree; the menu only calls `router.refresh()` after a successful action, so
// a stub is enough for these capacity-focused render tests.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

describe("TaskCardMenu start item vs. capacity", () => {
  it("enables Start when the only other active task is awaiting_gate", () => {
    render(
      <TaskCardMenu
        taskId="task_1"
        taskTitle="New task"
        capacity={{
          slotAvailable: true,
          limit: 1,
          blocking: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(/Limit of/)).toBeNull();
  });

  it("disables Start and names the running task when capacity is exhausted", () => {
    render(
      <TaskCardMenu
        taskId="task_2"
        taskTitle="New task"
        capacity={{
          slotAvailable: false,
          limit: 1,
          blocking: [{ id: "task_running", title: "Running task" }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Limit of 1 task in progress reached/)).toBeTruthy();
    expect(screen.getByText(/Running task is still running\./)).toBeTruthy();
  });
});
