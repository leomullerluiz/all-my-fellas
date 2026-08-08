// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatePanel } from "@/components/task-actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

/**
 * Type-level only — never executed. `GatePanel` (and `gateCopy` underneath)
 * must fail to compile without provider context, so a caller with no
 * provider in scope cannot silently render "GitHub" — see
 * `spec-execution-honesty.md` §7.4. Checked by `tsc --noEmit`, not by
 * running this test file.
 */
function typeAssertionGatePanelRequiresProvider() {
  // @ts-expect-error — `provider` is a required prop.
  return <GatePanel taskId="task_1" gate="STAKEHOLDER_GATE" />;
}
void typeAssertionGatePanelRequiresProvider;

/**
 * S3 regression — `task-actions.tsx:38`'s old hardcoded "pull request" /
 * "GitHub" must track the connected repo's actual provider. `STAKEHOLDER_GATE`
 * is the only gate whose copy names a provider at all.
 */
describe("GatePanel provider-agnostic copy", () => {
  it("renders 'merge request' and 'GitLab' for a GitLab-connected repo, never 'pull request' or 'GitHub'", () => {
    const { container } = render(
      <GatePanel
        taskId="task_1"
        gate="STAKEHOLDER_GATE"
        provider={{ displayName: "GitLab", changeRequestNoun: "merge request" }}
      />,
    );

    expect(screen.getByText(/opens a merge request/)).toBeTruthy();
    expect(screen.getByText(/merge still happens on GitLab/)).toBeTruthy();

    const html = container.innerHTML;
    expect(html).not.toMatch(/pull request/i);
    expect(html).not.toContain("GitHub");

    // Every title/aria-label attribute in the rendered tree, not just text nodes.
    for (const el of container.querySelectorAll("[title], [aria-label]")) {
      const title = el.getAttribute("title") ?? "";
      const label = el.getAttribute("aria-label") ?? "";
      expect(title).not.toMatch(/pull request/i);
      expect(title).not.toContain("GitHub");
      expect(label).not.toMatch(/pull request/i);
      expect(label).not.toContain("GitHub");
    }
  });

  it("renders 'pull request' and 'GitHub' for a GitHub-connected repo", () => {
    render(
      <GatePanel
        taskId="task_1"
        gate="STAKEHOLDER_GATE"
        provider={{ displayName: "GitHub", changeRequestNoun: "pull request" }}
      />,
    );

    expect(screen.getByText(/opens a pull request/)).toBeTruthy();
    expect(screen.getByText(/merge still happens on GitHub/)).toBeTruthy();
  });
});
