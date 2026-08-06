// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderTestButton } from "@/components/provider-test-button";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("ProviderTestButton", () => {
  it("posts the provider id, disables itself while in flight, then toasts the success text", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ProviderTestButton provider="gemini" />);

    const button = screen.getByRole("button", { name: "Test connection" });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("button", { name: "Testing…" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Testing…" }).hasAttribute("disabled")).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/settings/test-provider");
    expect(JSON.parse(init.body as string)).toEqual({ provider: "gemini" });

    resolveFetch({
      ok: true,
      json: async () => ({ provider: "gemini", label: "Gemini (Google)", text: "teste recebido" }),
    });

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Gemini (Google) responded: teste recebido"),
    );
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows an error toast and re-enables the button on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "No Gemini credential found. Set GEMINI_API_KEY." }),
      }),
    );

    render(<ProviderTestButton provider="gemini" />);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("No Gemini credential found. Set GEMINI_API_KEY."),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("keeps two provider instances' busy state independent", async () => {
    let resolveGemini!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { provider: string };
      if (body.provider === "gemini") {
        return new Promise((resolve) => {
          resolveGemini = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ provider: "claude", label: "Claude (Anthropic)", text: "ok" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <>
        <ProviderTestButton provider="gemini" />
        <ProviderTestButton provider="claude" />
      </>,
    );

    const [geminiButton, claudeButton] = screen.getAllByRole("button", { name: "Test connection" });
    fireEvent.click(geminiButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "Testing…" })).toBeTruthy());
    // Claude's control is untouched while Gemini's is in flight.
    expect(claudeButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(claudeButton);
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Claude (Anthropic) responded: ok"),
    );

    resolveGemini({
      ok: true,
      json: async () => ({ provider: "gemini", label: "Gemini (Google)", text: "done" }),
    });
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Gemini (Google) responded: done"),
    );
  });
});
