// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "react-toastify";

import { ToastProvider } from "@/components/toast-provider";

afterEach(() => {
  cleanup();
});

describe("ToastProvider", () => {
  it("stacks two back-to-back toasts instead of one replacing the other", async () => {
    render(<ToastProvider />);

    act(() => {
      toast.success("First toast");
      toast.error("Second toast");
    });

    await waitFor(() => {
      expect(document.querySelectorAll(".Toastify__toast").length).toBe(2);
    });
  });
});
