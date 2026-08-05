// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewTaskForm } from "@/components/new-task-form";

// The form only calls `router.push`/`router.refresh` after a fetch resolves;
// these render-only tests never trigger that, so a stub suffices.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const REPOS = [{ id: "repo_1", name: "acme/app", defaultBranch: "main" }];

describe("NewTaskForm dependency multi-select", () => {
  it("renders no dependency picker when there is nothing to depend on", () => {
    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    expect(screen.queryByText("Depends on")).toBeNull();
  });

  it("lists each candidate task with its title and repo name", () => {
    render(
      <NewTaskForm
        repos={REPOS}
        dependencyOptions={[
          { id: "task_a", title: "Set up the schema", repoName: "acme/app" },
          { id: "task_b", title: "Write the migration", repoName: "acme/other" },
        ]}
      />,
    );

    expect(screen.getByText("Depends on")).toBeTruthy();
    expect(screen.getByText(/Set up the schema/)).toBeTruthy();
    expect(screen.getByText(/\(acme\/app\)/)).toBeTruthy();
    expect(screen.getByText(/Write the migration/)).toBeTruthy();
    expect(screen.getByText(/\(acme\/other\)/)).toBeTruthy();
  });

  it("pre-selects the task's stored prerequisites in edit mode", () => {
    render(
      <NewTaskForm
        repos={REPOS}
        mode="edit"
        taskId="task_edit"
        dependencyOptions={[{ id: "task_a", title: "Set up the schema", repoName: "acme/app" }]}
        initial={{
          repoId: "repo_1",
          title: "Existing",
          description: "An existing description, long enough to pass validation.",
          priority: "medium",
          requireHumanCodeReview: false,
          attachments: [],
          dependsOn: ["task_a"],
        }}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Set up the schema/ });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
});
