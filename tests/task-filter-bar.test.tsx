// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskFilterBar } from "@/components/task-filter-bar";

/**
 * S2/S3 — the board's date-range filter bar. `next/navigation`'s `useRouter`
 * requires a router context outside the app tree, so it's mocked the same
 * way `tests/batch-start.test.tsx`/`tests/task-card-menu.test.tsx` do; this
 * component only ever calls `router.push`.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  push.mockClear();
});

/** `YYYY-MM-DD` for a given day of the *current* calendar month/year. */
function currentMonthDateKey(day: number): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${String(day).padStart(2, "0")}`;
}

/**
 * Finds a day button inside an open calendar popover by its visible day
 * number, ignoring the leading/trailing-month "outside" days react-day-picker
 * pads the grid with — text content alone (e.g. "5") is ambiguous once
 * outside days are included, since a 31-day month can show day 5 of the
 * next month too.
 */
function findDayButton(day: number): HTMLElement {
  const cells = document.querySelectorAll('td[role="gridcell"]:not([data-outside="true"])');
  for (const cell of Array.from(cells)) {
    const button = cell.querySelector("button");
    if (button?.textContent?.trim() === String(day)) return button as HTMLElement;
  }
  throw new Error(`No in-month day button found for day ${day}`);
}

describe("default (no applied range)", () => {
  it("shows the default-view label and no Reset control", () => {
    render(<TaskFilterBar />);

    expect(screen.getByText("Showing today's and open tasks")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });
});

describe("applying a valid range", () => {
  it("navigates to /?start=...&end=... once both dates are picked and Apply is clicked", async () => {
    const user = userEvent.setup();
    render(<TaskFilterBar />);

    await user.click(screen.getByRole("button", { name: "Start date" }));
    await user.click(findDayButton(5));

    await user.click(screen.getByRole("button", { name: "End date" }));
    await user.click(findDayButton(15));

    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(push).toHaveBeenCalledWith(
      `/?start=${currentMonthDateKey(5)}&end=${currentMonthDateKey(15)}`,
    );
  });
});

describe("invalid range", () => {
  it("rejects an end date before the start date without navigating", async () => {
    const user = userEvent.setup();
    render(<TaskFilterBar />);

    await user.click(screen.getByRole("button", { name: "Start date" }));
    await user.click(findDayButton(20));

    await user.click(screen.getByRole("button", { name: "End date" }));
    await user.click(findDayButton(10));

    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("End date can't be before the start date.")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Reset", () => {
  it("is shown only while a custom range is applied and clears it back to the default", async () => {
    const user = userEvent.setup();
    render(<TaskFilterBar initialStart="2026-01-03" initialEnd="2026-01-07" />);

    expect(screen.getByText(/Jan 3.*Jan 7, 2026/)).toBeTruthy();
    const reset = screen.getByRole("button", { name: "Reset" });

    await user.click(reset);

    expect(push).toHaveBeenCalledWith("/");
  });
});
