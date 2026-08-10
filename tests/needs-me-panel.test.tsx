// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NeedsMePanel, type NeedsMeTask } from "@/components/needs-me-panel";

// Same stub pattern as `task-card-menu.test.tsx` — the panel only calls
// `router.refresh()` after a successful gate decision.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const NOW = new Date(2026, 7, 5, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

function task(overrides: Partial<NeedsMeTask> = {}): NeedsMeTask {
  return {
    id: "task_1",
    title: "Refactor billing",
    currentStage: "PLAN_GATE",
    updatedAt: NOW - 2 * HOUR,
    ...overrides,
  };
}

describe("NeedsMePanel", () => {
  it("renders nothing when there is nothing waiting", () => {
    const { container } = render(<NeedsMePanel tasks={[]} now={NOW} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists every waiting task with its gate and how long it has waited", () => {
    render(<NeedsMePanel tasks={[task()]} now={NOW} />);
    expect(screen.getByText("Refactor billing")).toBeTruthy();
    expect(screen.getByText(/Plan gate/)).toBeTruthy();
    expect(screen.getByText(/waiting 2h/)).toBeTruthy();
  });

  // S6 AC2 — the one gate that must never be decidable inline.
  it("HUMAN_CODE_REVIEW rows link to the review screen instead of offering inline decisions", () => {
    render(<NeedsMePanel tasks={[task({ currentStage: "HUMAN_CODE_REVIEW" })]} now={NOW} />);

    const link = screen.getByRole("link", { name: /Open the diff viewer/ });
    expect(link.getAttribute("href")).toBe("/tasks/task_1/review");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("every non-HUMAN_CODE_REVIEW gate offers inline Approve/Reject", () => {
    render(<NeedsMePanel tasks={[task({ currentStage: "PLAN_GATE" })]} now={NOW} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the diff viewer/ })).toBeNull();
  });

  it("Approve posts to the same gate endpoint GatePanel uses, then refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<NeedsMePanel tasks={[task({ currentStage: "PLAN_GATE" })]} now={NOW} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/task_1/gates/PLAN_GATE",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
  });

  it("does not refresh when the decision request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<NeedsMePanel tasks={[task({ currentStage: "PLAN_GATE" })]} now={NOW} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
  });
});
