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

describe("TaskControls start button vs. dependencies", () => {
  it("disables Start and names the incomplete prerequisite, distinct from a capacity message", () => {
    render(
      <TaskControls
        taskId="task_3"
        taskTitle="New task"
        status="queued"
        notStarted
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        dependsOn={[{ title: "Design the schema", status: "queued" }]}
      />,
    );

    const startButton = screen.getByRole("button", { name: "Start" });
    expect(startButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Design the schema/)).toBeTruthy();
    expect(screen.queryByText(/Limit of/)).toBeNull();
  });

  it("enables Start once every prerequisite is completed", () => {
    render(
      <TaskControls
        taskId="task_4"
        taskTitle="New task"
        status="queued"
        notStarted
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        dependsOn={[{ title: "Design the schema", status: "completed" }]}
      />,
    );

    const startButton = screen.getByRole("button", { name: "Start" });
    expect(startButton.hasAttribute("disabled")).toBe(false);
  });
});

describe("TaskControls gate_queued status (S2)", () => {
  it("shows the queued reason and Cancel, with no error state", () => {
    render(
      <TaskControls
        taskId="task_5"
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

describe("TaskControls retry availability (S3)", () => {
  const capacity = { slotAvailable: true, limit: 1, blocking: [] };

  it("renders a stage-labelled, enabled button when available", () => {
    render(
      <TaskControls
        taskId="task_6"
        taskTitle="Failed task"
        status="failed"
        notStarted={false}
        capacity={capacity}
        retry={{
          available: true,
          stage: "DEVELOPMENT",
          attempt: 4,
          cause: "rework_exhausted",
          grantsReworkCycles: 1,
          reworkMaxCycles: 3,
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Retry Developer" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Grants 1 extra rework cycle \(3 total\)\./)).toBeTruthy();
  });

  it("does not show the grant line when grantsReworkCycles is 0", () => {
    render(
      <TaskControls
        taskId="task_7"
        taskTitle="Failed task"
        status="failed"
        notStarted={false}
        capacity={capacity}
        retry={{
          available: true,
          stage: "CODE_REVIEW",
          attempt: 2,
          cause: "stage_error",
          grantsReworkCycles: 0,
          reworkMaxCycles: 2,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry Code review" })).toBeTruthy();
    expect(screen.queryByText(/Grants/)).toBeNull();
  });

  it("renders a disabled button with the blocking task's title visible as text for capacity", () => {
    render(
      <TaskControls
        taskId="task_8"
        taskTitle="Failed task"
        status="failed"
        notStarted={false}
        capacity={{ slotAvailable: false, limit: 1, blocking: [{ title: "Running task" }] }}
        retry={{ available: false, code: "capacity", reason: "No capacity slot is free right now." }}
      />,
    );

    const button = screen.getByRole("button", { name: "Retry failed stage" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Running task is still running\./)).toBeTruthy();
  });

  it.each(["not_failed", "no_failed_stage", "workspace_gone"] as const)(
    "renders no button, only the reason, for %s",
    (code) => {
      render(
        <TaskControls
          taskId="task_9"
          taskTitle="Failed task"
          status="failed"
          notStarted={false}
          capacity={capacity}
          retry={{ available: false, code, reason: `Refused: ${code}.` }}
        />,
      );

      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
      expect(screen.getByText(`Refused: ${code}.`)).toBeTruthy();
    },
  );
});

describe("TaskControls Duplicate link (S4)", () => {
  const capacity = { slotAvailable: true, limit: 1, blocking: [] };

  it("renders for a not-yet-started task", () => {
    render(
      <TaskControls
        taskId="task_10"
        taskTitle="New task"
        status="queued"
        notStarted
        capacity={capacity}
      />,
    );

    const link = screen.getByRole("link", { name: "Duplicate" });
    expect(link.getAttribute("href")).toBe("/tasks/new?from=task_10");
  });

  it("renders for a completed task, which today gets no other controls at all", () => {
    render(
      <TaskControls
        taskId="task_11"
        taskTitle="Done task"
        status="completed"
        notStarted={false}
        capacity={capacity}
      />,
    );

    const link = screen.getByRole("link", { name: "Duplicate" });
    expect(link.getAttribute("href")).toBe("/tasks/new?from=task_11");
  });

  it("renders for a rejected task", () => {
    render(
      <TaskControls
        taskId="task_12"
        taskTitle="Rejected task"
        status="rejected"
        notStarted={false}
        capacity={capacity}
      />,
    );

    const link = screen.getByRole("link", { name: "Duplicate" });
    expect(link.getAttribute("href")).toBe("/tasks/new?from=task_12");
  });

  it("renders alongside Retry for a failed task", () => {
    render(
      <TaskControls
        taskId="task_13"
        taskTitle="Failed task"
        status="failed"
        notStarted={false}
        capacity={capacity}
        retry={{ available: false, code: "not_failed", reason: "x" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Duplicate" })).toBeTruthy();
  });
});
