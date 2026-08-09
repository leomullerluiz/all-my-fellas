// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskCardMenu } from "@/components/task-card-menu";
import type { QuotaStatus } from "@/server/usage/quota";

// `next/navigation`'s `useRouter` requires a router context outside the app
// tree; the menu only calls `router.refresh()` after a successful action, so
// a stub is enough for these capacity-focused render tests.
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
}));

afterEach(() => {
  cleanup();
  push.mockClear();
  refresh.mockClear();
});

// The trigger is Radix's `DropdownMenuTrigger`, which opens on `pointerdown`
// rather than `click` — `fireEvent.click` alone (used before this component
// moved onto Radix) never dispatches that event in jsdom, so every test here
// opens the menu with `userEvent`, which synthesizes the full pointer
// sequence a real click produces. No assertion below changed as a result.
async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Task actions" }));
  return user;
}

describe("TaskCardMenu start item vs. capacity", () => {
  it("enables Start when the only other active task is awaiting_gate", async () => {
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

    await openMenu();

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(/Limit of/)).toBeNull();
  });

  it("disables Start and names the running task when capacity is exhausted, with a title tooltip", async () => {
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

    await openMenu();

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.getAttribute("aria-disabled")).toBe("true");
    expect(startItem.getAttribute("title")).toMatch(/Limit of 1 task in progress reached/);
    expect(screen.getByText(/Limit of 1 task in progress reached/)).toBeTruthy();
    expect(screen.getByText(/Running task is still running\./)).toBeTruthy();
  });
});

describe("TaskCardMenu start item vs. dependencies", () => {
  it("disables Start and names the incomplete prerequisite, distinct from a capacity message", async () => {
    render(
      <TaskCardMenu
        taskId="task_8"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        dependsOn={[{ id: "task_prereq", title: "Design the schema", status: "queued" }]}
      />,
    );

    await openMenu();

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Design the schema/)).toBeTruthy();
    expect(screen.queryByText(/Limit of/)).toBeNull();
  });

  it("enables Start once every prerequisite is completed", async () => {
    render(
      <TaskCardMenu
        taskId="task_9"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        dependsOn={[{ id: "task_prereq", title: "Design the schema", status: "completed" }]}
      />,
    );

    await openMenu();

    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("TaskCardMenu quota warning (S4 — beside every Start affordance)", () => {
  const QUOTA_WARNING: QuotaStatus = {
    provider: "gemini",
    state: "warning",
    cadence: "daily",
    limitUsd: 10,
    usedUsd: 9,
    remainingUsd: 1,
    resetAt: 0,
  };

  it("shows nothing when no quota is configured", async () => {
    render(
      <TaskCardMenu
        taskId="task_quota_none"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    await openMenu();

    expect(screen.queryByText(/quota/i)).toBeNull();
  });

  it("shows a warning note without disabling Start when a provider is approaching its quota", async () => {
    render(
      <TaskCardMenu
        taskId="task_quota_warning"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        quotas={[QUOTA_WARNING]}
      />,
    );

    await openMenu();

    expect(screen.getByText("Approaching Gemini (Google) quota.")).toBeTruthy();
    const startItem = screen.getByRole("menuitem", { name: "Start" });
    expect(startItem.hasAttribute("aria-disabled")).toBe(false);
  });

  it("shows an exceeded note when a provider is over its quota", async () => {
    render(
      <TaskCardMenu
        taskId="task_quota_exceeded"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
        quotas={[{ ...QUOTA_WARNING, state: "exceeded" }]}
      />,
    );

    await openMenu();

    expect(screen.getByText("Gemini (Google) quota exceeded.")).toBeTruthy();
  });
});

describe("TaskCardMenu Edit item", () => {
  it("links to the task's edit page", async () => {
    render(
      <TaskCardMenu
        taskId="task_edit"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    await openMenu();

    const editItem = screen.getByRole("menuitem", { name: "Edit" });
    expect(editItem.tagName).toBe("A");
    expect(editItem.getAttribute("href")).toBe("/tasks/task_edit/edit");
  });
});

describe("TaskCardMenu Cancel item (on_queue only)", () => {
  it("does not show Cancel for a plain queued Created task", async () => {
    render(
      <TaskCardMenu
        taskId="task_3"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    await openMenu();

    expect(screen.queryByRole("menuitem", { name: "Cancel" })).toBeNull();
  });

  it("shows Cancel for a task parked on_queue", async () => {
    render(
      <TaskCardMenu
        taskId="task_4"
        taskTitle="New task"
        status="on_queue"
        capacity={{ slotAvailable: false, limit: 1, blocking: [{ id: "x", title: "Other" }] }}
      />,
    );

    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Cancel" })).toBeTruthy();
  });
});

describe("TaskCardMenu Delete item", () => {
  it("does not call the delete endpoint when the confirmation is dismissed", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <TaskCardMenu
        taskId="task_5"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("calls the delete endpoint exactly once the confirmation is accepted", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <TaskCardMenu
        taskId="task_6"
        taskTitle="New task"
        status="queued"
        capacity={{ slotAvailable: true, limit: 1, blocking: [] }}
      />,
    );

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(window.confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    expect(fetchSpy).toHaveBeenCalledWith("/api/tasks/task_6", { method: "DELETE" });

    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("TaskCardMenu arrow-key navigation", () => {
  it("moves focus between enabled items and skips the disabled Start item", async () => {
    render(
      <TaskCardMenu
        taskId="task_7"
        taskTitle="New task"
        status="on_queue"
        capacity={{ slotAvailable: false, limit: 1, blocking: [{ id: "x", title: "Other" }] }}
      />,
    );

    const user = await openMenu();

    // Opening via a pointer click (as `openMenu` does) focuses the menu
    // surface itself, not an item — same as a native context menu. The
    // first ArrowDown moves focus onto the first *enabled* item, skipping
    // the disabled Start item.
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" })),
    );

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel" }));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel" }));
  });
});
