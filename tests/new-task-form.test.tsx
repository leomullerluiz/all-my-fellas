// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewTaskForm } from "@/components/new-task-form";

// The form only calls `router.push`/`router.refresh` after a fetch resolves;
// these render-only tests never trigger that, so a stub suffices.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const DRAFT_STORAGE_KEY = "new-task-form:draft";

// The autosave feature (stories.md S1–S3) reads/writes real `localStorage`;
// clearing it on both sides of every test keeps drafts from leaking between
// the unrelated suites already in this file.
beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const REPOS = [
  { id: "repo_1", name: "acme/app", defaultBranch: "main", changeRequestNoun: "pull request" },
];

const TWO_REPOS = [
  { id: "repo_1", name: "acme/app", defaultBranch: "main", changeRequestNoun: "pull request" },
  { id: "repo_2", name: "acme/other", defaultBranch: "main", changeRequestNoun: "merge request" },
];

/** Candidates spanning both repos — the server passes every repo's tasks. */
const CROSS_REPO_OPTIONS = [
  { id: "task_a", title: "Set up the schema", repoId: "repo_1", repoName: "acme/app" },
  { id: "task_b", title: "Write the migration", repoId: "repo_2", repoName: "acme/other" },
];

function repoSelect() {
  return screen.getByLabelText("Repository") as HTMLSelectElement;
}

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
          { id: "task_a", title: "Set up the schema", repoId: "repo_1", repoName: "acme/app" },
          { id: "task_b", title: "Write the migration", repoId: "repo_1", repoName: "acme/app" },
        ]}
      />,
    );

    expect(screen.getByText("Depends on")).toBeTruthy();
    expect(screen.getByText(/Set up the schema/)).toBeTruthy();
    expect(screen.getByText(/Write the migration/)).toBeTruthy();
    expect(screen.getAllByText(/\(acme\/app\)/)).toHaveLength(2);
  });

  it("pre-selects the task's stored prerequisites in edit mode", () => {
    render(
      <NewTaskForm
        repos={REPOS}
        mode="edit"
        taskId="task_edit"
        dependencyOptions={[
          { id: "task_a", title: "Set up the schema", repoId: "repo_1", repoName: "acme/app" },
        ]}
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
 * The picker follows the "Repository" select: a prerequisite in another repo
 * gates work the agents never touch here, so it is neither offered nor kept.
 */
describe("NewTaskForm dependency multi-select — scoped to the selected repository", () => {
  it("offers only candidates from the repository selected on load", () => {
    render(<NewTaskForm repos={TWO_REPOS} dependencyOptions={CROSS_REPO_OPTIONS} />);

    expect(screen.getByText(/Set up the schema/)).toBeTruthy();
    expect(screen.queryByText(/Write the migration/)).toBeNull();
  });

  it("swaps the candidates when the repository changes", () => {
    render(<NewTaskForm repos={TWO_REPOS} dependencyOptions={CROSS_REPO_OPTIONS} />);

    fireEvent.change(repoSelect(), { target: { value: "repo_2" } });

    expect(screen.getByText(/Write the migration/)).toBeTruthy();
    expect(screen.queryByText(/Set up the schema/)).toBeNull();
  });

  it("explains an empty picker rather than hiding the field", () => {
    render(
      <NewTaskForm
        repos={TWO_REPOS}
        dependencyOptions={[CROSS_REPO_OPTIONS[0]]}
      />,
    );

    fireEvent.change(repoSelect(), { target: { value: "repo_2" } });

    expect(screen.getByText("Depends on")).toBeTruthy();
    expect(screen.getByText(/No other open task in acme\/other\./)).toBeTruthy();
  });

  it("drops a selection made before the repository changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={TWO_REPOS} dependencyOptions={CROSS_REPO_OPTIONS} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Set up the schema/ }));
    fireEvent.change(repoSelect(), { target: { value: "repo_2" } });

    // Back on repo_1 the box is clear again: the selection was dropped, not
    // parked in state where it would submit invisibly.
    fireEvent.change(repoSelect(), { target: { value: "repo_1" } });
    const checkbox = screen.getByRole("checkbox", { name: /Set up the schema/ });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    fireEvent.submit(document.querySelector("form")!);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as { dependsOn: string[] };
    expect(body.dependsOn).toEqual([]);

    vi.unstubAllGlobals();
  });
});

/**
 * S1/S2 of `depends-on` — a Completed task must not be offered as a
 * prerequisite. `dependencyOptions` is filtered server-side by
 * `listDependencyOptions` (task.status !== "completed") before it ever
 * reaches this component, so these tests build the props the same way that
 * function would: from a raw task list, filtered by status.
 */
type FakeTask = { id: string; title: string; repoId: string; repoName: string; status: string };

function dependencyOptionsFrom(fakeTasks: FakeTask[], excludeId?: string) {
  return fakeTasks
    .filter((task) => task.status !== "completed" && task.id !== excludeId)
    .map(({ id, title, repoId, repoName }) => ({ id, title, repoId, repoName }));
}

describe("NewTaskForm dependency multi-select — completed tasks excluded", () => {
  const TASKS: FakeTask[] = [
    {
      id: "task_open",
      title: "Still open",
      repoId: "repo_1",
      repoName: "acme/app",
      status: "queued",
    },
    {
      id: "task_done",
      title: "Already shipped",
      repoId: "repo_1",
      repoName: "acme/app",
      status: "completed",
    },
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

/**
 * S1 — the optional "Branch name" field on the create form. Only rendered in
 * create mode; its value flows into both submission branches of `submit()`.
 */
describe("NewTaskForm branch name field", () => {
  function fillRequiredFields() {
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "repo_1" } });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A perfectly reasonable title" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A description long enough to pass the twenty character minimum." },
    });
  }

  it("does not render the field in edit mode", () => {
    render(
      <NewTaskForm
        repos={REPOS}
        mode="edit"
        taskId="task_edit"
        initial={{
          repoId: "repo_1",
          title: "Existing",
          description: "An existing description, long enough to pass validation.",
          priority: "medium",
          requireHumanCodeReview: false,
          attachments: [],
          dependsOn: [],
        }}
      />,
    );
    expect(screen.queryByLabelText("Branch name")).toBeNull();
  });

  it("includes the typed value in the outgoing JSON request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feature/my-custom-name" },
    });

    const form = document.querySelector("form")!;
    fireEvent.submit(form);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as { branchName?: string };
    expect(body.branchName).toBe("feature/my-custom-name");

    vi.unstubAllGlobals();
  });

  it("omits branchName from the JSON body when the field is left empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    fillRequiredFields();

    const form = document.querySelector("form")!;
    fireEvent.submit(form);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("branchName");
    expect(body).toMatchObject({
      repoId: "repo_1",
      title: "A perfectly reasonable title",
      description: "A description long enough to pass the twenty character minimum.",
      priority: "medium",
      requireHumanCodeReview: false,
      dependsOn: [],
      start: false,
    });

    vi.unstubAllGlobals();
  });

  it("renders a returned details.branchName error under the field without a page reload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid request payload.",
        details: { branchName: "Branch names cannot contain spaces or any of ~ ^ : ? * [ `." },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "bad name" },
    });

    const form = document.querySelector("form")!;
    fireEvent.submit(form);

    await screen.findByText(/Branch names cannot contain spaces/);

    vi.unstubAllGlobals();
  });
});

/**
 * S4 — duplication prefills the create form from `initial` (title prefixed,
 * everything else copied) and threads `duplicateFrom` through to the create
 * request, exactly the shape `tasks/new/page.tsx?from=<id>` builds.
 */
describe("NewTaskForm duplicateFrom (S4)", () => {
  const DUPLICATE_INITIAL = {
    repoId: "repo_1",
    title: "Copy of Original feature",
    description: "The original description, long enough to pass validation.",
    priority: "high" as const,
    requireHumanCodeReview: true,
    // Deliberately empty: attachments are copied server-side, not prefilled
    // into the picker — see `tasks/new/page.tsx`'s doc comment.
    attachments: [],
    dependsOn: [],
  };

  it("prefills the title with the 'Copy of' prefix and the rest of the fields", () => {
    render(
      <NewTaskForm repos={REPOS} initial={DUPLICATE_INITIAL} duplicateFrom="task_source" />,
    );

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Copy of Original feature",
    );
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
      DUPLICATE_INITIAL.description,
    );
    // No existing-attachment rows — nothing to remove on a task that does not
    // exist yet.
    expect(screen.queryByText(/Remove/)).toBeNull();
  });

  it("sends duplicateFrom in the JSON create request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NewTaskForm repos={REPOS} initial={DUPLICATE_INITIAL} duplicateFrom="task_source" />,
    );

    fireEvent.submit(document.querySelector("form")!);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as { duplicateFrom?: string };
    expect(body.duplicateFrom).toBe("task_source");

    vi.unstubAllGlobals();
  });

  it("omits duplicateFrom when the form was not opened as a duplicate", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} initial={DUPLICATE_INITIAL} />);
    fireEvent.submit(document.querySelector("form")!);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("duplicateFrom");

    vi.unstubAllGlobals();
  });
});

describe("NewTaskForm spend at the decision point (S4)", () => {
  it("renders nothing when no provider has a configured quota", () => {
    render(<NewTaskForm repos={REPOS} spend={{ spendToday: 5, authMode: "missing", quotas: [] }} />);
    expect(screen.queryByText(/used of/)).toBeNull();
  });

  it("renders the usage bar beside Start now when a provider has a configured quota", () => {
    render(
      <NewTaskForm
        repos={REPOS}
        spend={{
          spendToday: 5,
          authMode: "api_key",
          quotas: [
            {
              provider: "chatgpt",
              state: "normal",
              cadence: "daily",
              limitUsd: 10,
              usedUsd: 5,
              remainingUsd: 5,
              resetAt: Date.now(),
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/\$5\.00 used of \$10\.00/)).toBeTruthy();
  });
});

function readDraft(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/**
 * The restore/hydrate effect defers its `setState` calls to a microtask (see
 * `new-task-form.tsx`'s doc comment on that effect), so the write effect's
 * very first echo write also lands one microtask after mount. Waiting for it
 * here mirrors what a real browser paint/interaction would already overlap.
 */
async function waitForHydration() {
  await vi.waitFor(() => expect(readDraft()).not.toBeNull());
}

/**
 * S1 — every tracked field is written to the dedicated `localStorage` draft
 * key as it changes, in create mode only, without files.
 */
describe("NewTaskForm autosave (S1)", () => {
  it("persists the repository, title, branch name, description, priority, spend ceiling and review checkbox as they change", async () => {
    render(<NewTaskForm repos={TWO_REPOS} dependencyOptions={[]} />);
    await waitForHydration();

    fireEvent.change(repoSelect(), { target: { value: "repo_2" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Autosaved title" } });
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feature/autosave" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "An autosaved description." },
    });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByLabelText("Spend ceiling (USD)"), {
      target: { value: "5.5" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Require human code review before delivery/ }),
    );

    expect(readDraft()).toMatchObject({
      repoId: "repo_2",
      title: "Autosaved title",
      branchName: "feature/autosave",
      description: "An autosaved description.",
      priority: "urgent",
      maxCostPerTaskUsd: "5.5",
      requireHumanCodeReview: true,
    });
  });

  it("does not persist the depends-on selection", async () => {
    render(
      <NewTaskForm
        repos={REPOS}
        dependencyOptions={[
          { id: "task_a", title: "Set up the schema", repoId: "repo_1", repoName: "acme/app" },
        ]}
      />,
    );
    await waitForHydration();

    fireEvent.click(screen.getByRole("checkbox", { name: /Set up the schema/ }));

    expect(readDraft()).not.toHaveProperty("dependsOn");
  });

  it("writes nothing in edit mode", async () => {
    render(
      <NewTaskForm
        repos={REPOS}
        mode="edit"
        taskId="task_edit"
        initial={{
          repoId: "repo_1",
          title: "Existing",
          description: "An existing description, long enough to pass validation.",
          priority: "medium",
          requireHumanCodeReview: false,
          attachments: [],
          dependsOn: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited title" } });

    // Give the (no-op, in edit mode) hydrate microtask a turn to run too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readDraft()).toBeNull();
  });

  it("never includes file data in the stored draft", async () => {
    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    await waitForHydration();

    const file = new File(["content"], "note.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Attachments"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "With an attachment" } });

    const draft = readDraft();
    expect(draft).not.toBeNull();
    expect(JSON.stringify(draft)).not.toContain("note.txt");
  });
});

/**
 * S2 — a stored draft pre-fills the create form on a fresh mount, silently
 * and without a click, except when `initial` (the duplicate-from flow) is
 * supplied, which always wins.
 */
describe("NewTaskForm draft restore (S2)", () => {
  it("pre-fills fields from a stored draft on mount", async () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        repoId: "repo_2",
        title: "Restored title",
        branchName: "feature/restored",
        description: "Restored description.",
        priority: "high",
        requireHumanCodeReview: true,
        dependsOn: [],
        maxCostPerTaskUsd: "9.99",
      }),
    );

    render(<NewTaskForm repos={TWO_REPOS} dependencyOptions={[]} />);

    await screen.findByDisplayValue("Restored title");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Restored title");
    expect((screen.getByLabelText("Branch name") as HTMLInputElement).value).toBe(
      "feature/restored",
    );
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
      "Restored description.",
    );
    expect((repoSelect()).value).toBe("repo_2");
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("high");
    expect((screen.getByLabelText("Spend ceiling (USD)") as HTMLInputElement).value).toBe("9.99");
    expect(
      (screen.getByRole("checkbox", {
        name: /Require human code review before delivery/,
      }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("does not announce restoration with a toast", () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ title: "Restored title" }),
    );
    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets a duplicate-from `initial` prop take precedence over a stored draft", () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ title: "Stale draft title", description: "Stale draft description." }),
    );

    render(
      <NewTaskForm
        repos={REPOS}
        initial={{
          repoId: "repo_1",
          title: "Copy of Original feature",
          description: "The original description, long enough to pass validation.",
          priority: "high",
          requireHumanCodeReview: true,
          attachments: [],
          dependsOn: [],
        }}
        duplicateFrom="task_source"
      />,
    );

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Copy of Original feature",
    );
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
      "The original description, long enough to pass validation.",
    );
  });

  it("leaves the depends-on checkboxes unchecked, even for a legacy draft containing dependsOn", () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ title: "Restored title", dependsOn: ["task_a"] }),
    );

    render(
      <NewTaskForm
        repos={REPOS}
        dependencyOptions={[
          { id: "task_a", title: "Set up the schema", repoId: "repo_1", repoName: "acme/app" },
        ]}
      />,
    );

    expect(
      (screen.getByRole("checkbox", { name: /Set up the schema/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("renders unchanged defaults when there is no stored draft", () => {
    render(<NewTaskForm repos={TWO_REPOS} dependencyOptions={[]} />);

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("");
    expect(repoSelect().value).toBe("repo_1");
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("medium");
    expect(
      (screen.getByRole("checkbox", {
        name: /Require human code review before delivery/,
      }) as HTMLInputElement).checked,
    ).toBe(false);
  });
});

/**
 * S3 — the stored draft is cleared once `POST /api/tasks` succeeds, and left
 * alone on a failed request so the user's work is still recoverable.
 */
describe("NewTaskForm draft cleared on success (S3)", () => {
  async function fillRequiredFields() {
    await waitForHydration();
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "repo_1" } });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A perfectly reasonable title" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A description long enough to pass the twenty character minimum." },
    });
  }

  it("removes the draft after a successful 'Add to queue' submit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    await fillRequiredFields();
    expect(readDraft()).not.toBeNull();

    fireEvent.submit(document.querySelector("form")!);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(readDraft()).toBeNull());

    vi.unstubAllGlobals();
  });

  it("removes the draft after a successful 'Start now' submit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: "task_new" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    await fillRequiredFields();
    expect(readDraft()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Start now/ }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(readDraft()).toBeNull());

    vi.unstubAllGlobals();
  });

  it("keeps the draft when the request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid request payload.", details: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);
    await fillRequiredFields();
    expect(readDraft()).not.toBeNull();

    fireEvent.submit(document.querySelector("form")!);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(readDraft()).not.toBeNull();
    expect(readDraft()).toMatchObject({ title: "A perfectly reasonable title" });

    vi.unstubAllGlobals();
  });

  it("shows the form at defaults, not the just-created task's values, after reloading /tasks/new", () => {
    // Simulates the state after S3's success path already ran clearNewTaskDraft().
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);

    render(<NewTaskForm repos={REPOS} dependencyOptions={[]} />);

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("");
  });
});
