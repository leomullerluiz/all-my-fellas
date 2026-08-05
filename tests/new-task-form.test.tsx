// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/**
 * S1/S2 of `depends-on` — a Completed task must not be offered as a
 * prerequisite. `dependencyOptions` is filtered server-side by
 * `listDependencyOptions` (task.status !== "completed") before it ever
 * reaches this component, so these tests build the props the same way that
 * function would: from a raw task list, filtered by status.
 */
type FakeTask = { id: string; title: string; repoName: string; status: string };

function dependencyOptionsFrom(fakeTasks: FakeTask[], excludeId?: string) {
  return fakeTasks
    .filter((task) => task.status !== "completed" && task.id !== excludeId)
    .map(({ id, title, repoName }) => ({ id, title, repoName }));
}

describe("NewTaskForm dependency multi-select — completed tasks excluded", () => {
  const TASKS: FakeTask[] = [
    { id: "task_open", title: "Still open", repoName: "acme/app", status: "queued" },
    { id: "task_done", title: "Already shipped", repoName: "acme/app", status: "completed" },
  ];

  it("does not render a checkbox for a completed task on create", () => {
    render(<NewTaskForm repos={REPOS} dependencyOptions={dependencyOptionsFrom(TASKS)} />);

    expect(screen.getByText(/Still open/)).toBeTruthy();
    expect(screen.queryByText(/Already shipped/)).toBeNull();
  });

  it("hides a since-completed dependency in edit mode but still submits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_edit" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NewTaskForm
        repos={REPOS}
        mode="edit"
        taskId="task_edit"
        dependencyOptions={dependencyOptionsFrom(TASKS, "task_edit")}
        initial={{
          repoId: "repo_1",
          title: "Existing",
          description: "An existing description, long enough to pass validation.",
          priority: "medium",
          requireHumanCodeReview: false,
          attachments: [],
          // Depends on both — task_done has since completed and is no longer
          // in dependencyOptions, but must not be dropped from state.
          dependsOn: ["task_open", "task_done"],
        }}
      />,
    );

    // Only the still-open prerequisite renders as a selectable/checked option.
    expect(screen.getByRole("checkbox", { name: /Still open/ })).toBeTruthy();
    expect(screen.queryByText(/Already shipped/)).toBeNull();

    const form = document.querySelector("form")!;
    fireEvent.submit(form);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as { dependsOn: string[] };
    expect(body.dependsOn).toEqual(["task_open", "task_done"]);

    vi.unstubAllGlobals();
  });
});
