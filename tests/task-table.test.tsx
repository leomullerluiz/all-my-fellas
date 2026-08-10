// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TaskTable, type TaskTableRow } from "@/components/task-table";

/** S9 §4.5 — `/tasks`' sortable table. */

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

afterEach(cleanup);

function row(overrides: Partial<TaskTableRow> = {}): TaskTableRow {
  return {
    id: "task_1",
    title: "Refactor billing",
    repoName: "all-my-fellas",
    stage: "DEVELOPMENT",
    status: "running",
    createdAt: NOW - 2 * HOUR,
    costUsd: 1.5,
    ...overrides,
  };
}

describe("TaskTable", () => {
  it("renders every row's title, repo, status, age and cost", () => {
    render(<TaskTable rows={[row()]} sort="age" dir="desc" now={NOW} searchPrefix="" />);

    expect(screen.getByRole("link", { name: "Refactor billing" }).getAttribute("href")).toBe("/tasks/task_1");
    expect(screen.getByText("all-my-fellas")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("2h ago")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    expect(screen.getByText("Developer")).toBeTruthy();
  });

  it("marks the active sort column with a direction arrow and flips it on the sort link", () => {
    render(<TaskTable rows={[row()]} sort="cost" dir="asc" now={NOW} searchPrefix="q=billing" />);

    const costHeader = screen.getByRole("link", { name: /Cost/ });
    expect(costHeader.textContent).toBe("Cost ↑");
    const url = new URL(costHeader.getAttribute("href")!, "http://internal");
    expect(url.pathname).toBe("/tasks");
    expect(url.searchParams.get("sort")).toBe("cost");
    expect(url.searchParams.get("dir")).toBe("desc");
    expect(url.searchParams.get("q")).toBe("billing");

    const titleHeader = screen.getByRole("link", { name: "Title" });
    expect(titleHeader.textContent).toBe("Title");
  });

  it("a column not currently sorted links to ascending first", () => {
    render(<TaskTable rows={[row()]} sort="cost" dir="asc" now={NOW} searchPrefix="" />);

    const titleHeader = screen.getByRole("link", { name: "Title" });
    const url = new URL(titleHeader.getAttribute("href")!, "http://internal");
    expect(url.searchParams.get("dir")).toBe("asc");
  });
});
