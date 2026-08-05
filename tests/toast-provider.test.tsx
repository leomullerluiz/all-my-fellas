// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "sonner";

import { ToastProvider } from "@/components/toast-provider";

afterEach(() => {
  cleanup();
});

describe("ToastProvider", () => {
  it("stacks two back-to-back toasts instead of one replacing the other", async () => {
    // Explicit "dark" theme: jsdom doesn't implement `window.matchMedia`, which
    // Sonner's "system" theme resolution depends on.
    render(<ToastProvider theme="dark" />);

    act(() => {
      toast.success("First toast");
      toast.error("Second toast");
    });

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sonner-toast]").length).toBe(2);
    });
  });
});
