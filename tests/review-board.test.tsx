// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewBoard } from "@/components/review-board";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// `DiffViewer` fetches from the same task-scoped API on mount; stub it out so
// this file exercises only the dirty-tree warning and commit action (S3).
vi.mock("@/components/diff-viewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const GITHUB_PROVIDER = { displayName: "GitHub", changeRequestNoun: "pull request" };

function mockFetchSequence(responses: Array<{ ok: boolean; body: unknown }>) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return {
        ok: next.ok,
        json: async () => next.body,
      } as Response;
    }),
  );
}

describe("ReviewBoard dirty-tree warning (S3)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("shows no warning when the workspace is clean", async () => {
    mockFetchSequence([{ ok: true, body: { available: true, dirty: false } }]);
    render(<ReviewBoard taskId="task_1" atGate={true} provider={GITHUB_PROVIDER} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/task_1/workspace/status"));
    expect(screen.queryByText(/uncommitted changes/)).toBeNull();
  });

  it("shows no warning when the workspace is unavailable (e.g. cleaned up)", async () => {
    mockFetchSequence([{ ok: true, body: { available: false, dirty: false } }]);
    render(<ReviewBoard taskId="task_1" atGate={true} provider={GITHUB_PROVIDER} />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/uncommitted changes/)).toBeNull();
  });

  it("warns and offers a commit action when the workspace is dirty", async () => {
    mockFetchSequence([{ ok: true, body: { available: true, dirty: true } }]);
    render(<ReviewBoard taskId="task_1" atGate={true} provider={GITHUB_PROVIDER} />);

    await waitFor(() => expect(screen.getByText(/uncommitted changes/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Commit changes/ })).toBeTruthy();
  });

  it("clears the warning after a successful commit, without a page reload", async () => {
    mockFetchSequence([
      { ok: true, body: { available: true, dirty: true } }, // initial status
      { ok: true, body: { committed: true } }, // commit
      { ok: true, body: { available: true, dirty: false } }, // status re-check
    ]);
    render(<ReviewBoard taskId="task_1" atGate={true} provider={GITHUB_PROVIDER} />);

    await waitFor(() => expect(screen.getByText(/uncommitted changes/)).toBeTruthy());

    const button = screen.getByRole("button", { name: /Commit changes/ });
    await act(async () => {
      button.click();
    });

    await waitFor(() => expect(screen.queryByText(/uncommitted changes/)).toBeNull());
    expect(fetch).toHaveBeenCalledWith("/api/tasks/task_1/workspace/commit", { method: "POST" });
  });
});
