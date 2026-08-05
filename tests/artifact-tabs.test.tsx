// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactTabs, type ArtifactView } from "@/components/artifact-tabs";

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
});
