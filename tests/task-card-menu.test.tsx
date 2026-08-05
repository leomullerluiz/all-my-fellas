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
        status="queued"
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
        status="queued"
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

describe("TaskCardMenu start item vs. dependencies", () => {
  it("disables Start and names the incomplete prerequisite, distinct from a capacity message", () => {
    render(
      <TaskCardMenu
        taskId="task_5"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        dependsOn={[{ id: "task_prereq", title: "Design the schema", status: "queued" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Design the schema/)).toBeTruthy();
    expect(screen.queryByText(/Limit of/)).toBeNull();
  });

  it("enables Start once every prerequisite is completed", () => {
    render(
      <TaskCardMenu
        taskId="task_6"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        dependsOn={[{ id: "task_prereq", title: "Design the schema", status: "completed" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("TaskCardMenu Cancel item (on_queue only)", () => {
  it("does not show Cancel for a plain queued Created task", () => {
    render(
      <TaskCardMenu
        taskId="task_3"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));

    expect(screen.queryByRole("menuitem", { name: "Cancel" })).toBeNull();
  });

  it("shows Cancel for a task parked on_queue", () => {
    render(
      <TaskCardMenu
        taskId="task_4"
        taskTitle="New task"
        status="on_queue"
        capacity={{ slotAvailable: false, limit: 1, blocking: [{ id: "x", title: "Other" }] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));

    expect(screen.getByRole("menuitem", { name: "Cancel" })).toBeTruthy();
  });
});
