// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClosedTaskCardMenu } from "@/components/closed-task-card-menu";

// `next/navigation`'s `useRouter` requires a router context outside the app
// tree; the menu only calls `router.refresh()` after a successful action, so
// a stub is enough here — same pattern as `tests/task-card-menu.test.tsx`.
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
// rather than `click` — `fireEvent.click` never dispatches that event in
// jsdom, so every test here opens the menu with `userEvent`.
async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Task actions" }));
  return user;
}

describe("ClosedTaskCardMenu", () => {
  it("renders a trigger and opens a menu with a 'Move to Created' item", async () => {
    render(<ClosedTaskCardMenu taskId="task_1" taskTitle="Rejected task" />);

    const user = await openMenu();
    expect(screen.getByRole("menuitem", { name: "Move to Created" })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Move to Created" })).toBeNull(),
    );
  });

  it("posts to the reopen endpoint when 'Move to Created' is selected", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ task: {} }), { status: 200 }));

    render(<ClosedTaskCardMenu taskId="task_2" taskTitle="Failed task" />);

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Move to Created" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    expect(fetchSpy).toHaveBeenCalledWith("/api/tasks/task_2/reopen", { method: "POST" });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    fetchSpy.mockRestore();
  });

  it("swaps the label to 'Moving…' while the request is pending and ignores a second select", async () => {
    let resolveFetch: (value: Response) => void;
    const fetchSpy = vi.spyOn(global, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<ClosedTaskCardMenu taskId="task_3" taskTitle="Cancelled task" />);

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Move to Created" }));

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Moving…" })).toBeTruthy(),
    );

    // Re-selecting while pending is a no-op: still exactly one fetch call.
    await user.click(screen.getByRole("menuitem", { name: "Moving…" }));
    expect(fetchSpy).toHaveBeenCalledOnce();

    resolveFetch!(new Response(JSON.stringify({ task: {} }), { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    fetchSpy.mockRestore();
  });

  it("shows an inline error and keeps the menu state on a failed request", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Task is not in Not delivered anymore." }), {
          status: 409,
        }),
      );

    render(<ClosedTaskCardMenu taskId="task_4" taskTitle="Rejected task" />);

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Move to Created" }));

    await waitFor(() =>
      expect(screen.getByText("Task is not in Not delivered anymore.")).toBeTruthy(),
    );
    expect(refresh).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("shows a generic error message on a network failure", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    render(<ClosedTaskCardMenu taskId="task_5" taskTitle="Failed task" />);

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Move to Created" }));

    await waitFor(() =>
      expect(screen.getByText("The request failed. Is the server still running?")).toBeTruthy(),
    );
    expect(refresh).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
