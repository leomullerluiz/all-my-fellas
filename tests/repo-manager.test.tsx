// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepoManager, type ProviderOption, type RepoRowView } from "@/components/repo-manager";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const PROVIDERS: ProviderOption[] = [
  {
    id: "github",
    displayName: "GitHub",
    defaultCredentialEnvVar: "GITHUB_TOKEN",
    exampleUrl: "https://github.com/acme/app",
    autoDetectable: true,
  },
];

function repoFixture(overrides: Partial<RepoRowView> = {}): RepoRowView {
  return {
    id: "repo_1",
    name: "acme/app",
    url: "https://github.com/acme/app",
    provider: "github",
    providerName: "GitHub",
    defaultBranch: "main",
    createdAt: 0,
    taskCount: 0,
    credential: { variable: "GITHUB_TOKEN", present: true },
    hasContext: false,
    verifyInstall: null,
    verifyBuild: null,
    verifyTest: null,
    verifyLint: null,
    verifyTimeoutSeconds: 600,
    ...overrides,
  };
}

/**
 * Spec §5.2: detection never saves anything — the suggestion is prefilled
 * into the commands panel and the operator still has to press Save. This
 * closes the code-review finding that `suggestedCommands` was returned by
 * `POST /api/repos` but never read by the form at all.
 */
describe("RepoManager — suggested verification commands", () => {
  it("prefills the commands panel from POST /api/repos's suggestedCommands and opens it", async () => {
    const repo = repoFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        repo: { id: repo.id },
        verified: true,
        suggestedCommands: { install: "npm ci", build: "npm run build", test: "npm test" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RepoManager repos={[repo]} providers={PROVIDERS} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "acme/app" } });
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/app" },
    });

    const form = document.querySelector("form")!;
    fireEvent.submit(form);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The panel opens on its own — no extra "Edit commands" click needed —
    // and is prefilled with the detected commands, not blank.
    await screen.findByText("Hide verification commands");
    expect((screen.getByLabelText("Install") as HTMLInputElement).value).toBe("npm ci");
    expect((screen.getByLabelText("Build") as HTMLInputElement).value).toBe("npm run build");
    expect((screen.getByLabelText("Test") as HTMLInputElement).value).toBe("npm test");
    expect((screen.getByLabelText("Lint") as HTMLInputElement).value).toBe("");

    vi.unstubAllGlobals();
  });

  it("does not open the commands panel when detection finds nothing", async () => {
    const repo = repoFixture();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ repo: { id: repo.id }, verified: true, suggestedCommands: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RepoManager repos={[repo]} providers={PROVIDERS} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "acme/app" } });
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/app" },
    });

    fireEvent.submit(document.querySelector("form")!);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Hide verification commands")).toBeNull();

    vi.unstubAllGlobals();
  });
});
