// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoRefresh } from "@/components/auto-refresh";

/**
 * S5 §9.2 — `AutoRefresh` pauses its timer while the tab is hidden and
 * resumes (with an immediate catch-up refresh) once it becomes visible again.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => refresh() }),
}));

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AutoRefresh", () => {
  it("calls router.refresh() on the configured interval while visible", () => {
    render(<AutoRefresh intervalMs={1000} />);

    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops calling router.refresh() once the tab becomes hidden", () => {
    render(<AutoRefresh intervalMs={1000} />);

    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    refresh.mockClear();

    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes immediately and resumes ticking once the tab becomes visible again", () => {
    render(<AutoRefresh intervalMs={1000} />);

    setVisibility("hidden");
    refresh.mockClear();
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    // The catch-up call on return, before any timer tick.
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
