// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeliveryOutcomeBanner } from "@/components/task-actions";

// stories.md S1's "Try again" control. A 200 response from
// `POST /api/tasks/:id/deliver-retry` only means the retry *ran* — it can
// still carry `{change:{status:"manual"}}` when the underlying API call
// fails again, and the toast must say so rather than claiming success. See
// the code-review finding this component was changed to fix.

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastSuccess.mockClear();
  toastError.mockClear();
  routerRefresh.mockClear();
});

function renderBanner() {
  return render(
    <DeliveryOutcomeBanner
      taskId="task_1"
      reason="The credential was rejected (401)."
      compareUrl="https://git.example.com/acme/app/compare/main...pipeline/task-1"
      noun="pull request"
    />,
  );
}

describe("DeliveryOutcomeBanner", () => {
  it("toasts success when the retry actually creates the change request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ change: { status: "created" } }),
      }),
    );

    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Pull request opened."));
    expect(toastError).not.toHaveBeenCalled();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("does not toast success when a 200 response still carries a manual outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          change: { status: "manual", reason: "The credential was rejected (401)." },
        }),
      }),
    );

    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Still not opened: The credential was rejected (401).",
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // The banner stays up to try again — driven by `router.refresh()` re-reading
    // the still-manual `deliveryOutcome` from the server, not by this toast.
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("toasts the server's error and does not refresh on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "This task's change request was already opened." }),
      }),
    );

    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("This task's change request was already opened."),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
