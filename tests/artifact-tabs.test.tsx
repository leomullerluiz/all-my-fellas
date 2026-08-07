// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactTabs, ORDER, type ArtifactView } from "@/components/artifact-tabs";
import { ARTIFACT_TYPES } from "@/server/pipeline/stages";

afterEach(() => {
  cleanup();
});

const artifacts: ArtifactView[] = [
  { id: "a1", type: "brief", contentMd: "# Brief content", createdAt: 1 },
  { id: "a2", type: "stories", contentMd: "# Stories content", createdAt: 2 },
  { id: "a3", type: "techplan", contentMd: "# Techplan content", createdAt: 3 },
];

describe("ArtifactTabs", () => {
  it("defaults to the last artifact in pipeline order (techplan)", () => {
    render(<ArtifactTabs artifacts={artifacts} />);

    expect(screen.getByText("# Techplan content")).toBeTruthy();
    expect(screen.queryByText("# Brief content")).toBeNull();
  });

  it("swaps the visible content when another tab is clicked", async () => {
    const user = userEvent.setup();
    render(<ArtifactTabs artifacts={artifacts} />);

    await user.click(screen.getByRole("tab", { name: "brief.md" }));

    await waitFor(() => expect(screen.getByText("# Brief content")).toBeTruthy());
    expect(screen.queryByText("# Techplan content")).toBeNull();
  });

  it("renders the empty state when there are no artifacts yet", () => {
    render(<ArtifactTabs artifacts={[]} />);

    expect(screen.getByText(/Nothing produced yet/)).toBeTruthy();
  });

  it("gives every ArtifactType a position in ORDER — a total mapping, so a type missing here fails to compile", () => {
    for (const type of ARTIFACT_TYPES) {
      expect(typeof ORDER[type]).toBe("number");
    }
    expect(Object.keys(ORDER).length).toBe(ARTIFACT_TYPES.length);
    // No two types share a position, so sorting stays deterministic.
    expect(new Set(Object.values(ORDER)).size).toBe(ARTIFACT_TYPES.length);
  });
});

describe("ArtifactTabs — version switcher", () => {
  const versions = [
    { id: "a3", type: "dev_report" as const, stageRunId: "run3", attempt: 3, createdAt: 300, sizeBytes: 10 },
    { id: "a2", type: "dev_report" as const, stageRunId: "run2", attempt: 2, createdAt: 200, sizeBytes: 10 },
    { id: "a1", type: "dev_report" as const, stageRunId: "run1", attempt: 1, createdAt: 100, sizeBytes: 10 },
  ];
  const reworked: ArtifactView[] = [
    { id: "a3", type: "dev_report", contentMd: "# Report v3", createdAt: 300 },
  ];

  it("shows no switcher for a type with a single version", () => {
    render(<ArtifactTabs artifacts={artifacts} taskId="task_1" versions={[]} />);
    expect(screen.queryByText(/not latest/)).toBeNull();
    expect(screen.queryByText(/older/)).toBeNull();
  });

  it("opens on the newest version and badges it latest", () => {
    render(<ArtifactTabs artifacts={reworked} taskId="task_1" versions={versions} />);
    expect(screen.getByText("# Report v3")).toBeTruthy();
    expect(screen.getByText("latest")).toBeTruthy();
  });

  it("steps to an older version and badges it not latest", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/artifacts/a2")) {
        return new Response(JSON.stringify({ contentMd: "# Report v2" }), { status: 200 });
      }
      return new Response(JSON.stringify({ contentMd: "" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ArtifactTabs artifacts={reworked} taskId="task_1" versions={versions} />);

    await user.click(screen.getByRole("button", { name: /older/ }));

    await waitFor(() => expect(screen.getByText("# Report v2")).toBeTruthy());
    expect(screen.getByText("not latest")).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
