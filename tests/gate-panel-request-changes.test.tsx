// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatePanel } from "@/components/task-actions";
import { GATE_ALLOWED_DECISIONS, type Gate } from "@/server/pipeline/stages";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const GITHUB_PROVIDER = { displayName: "GitHub", changeRequestNoun: "pull request" };

/**
 * S1: `GatePanel` renders the "Request changes" button for every gate that
 * accepts the decision — driven entirely by `GATE_ALLOWED_DECISIONS`, with no
 * change to `GatePanel` itself.
 */
describe("GatePanel request_changes button", () => {
  for (const gate of Object.keys(GATE_ALLOWED_DECISIONS) as Gate[]) {
    it(`renders for ${gate}, which now allows the decision`, () => {
      render(<GatePanel taskId="task_1" gate={gate} provider={GITHUB_PROVIDER} />);
      expect(GATE_ALLOWED_DECISIONS[gate]).toContain("request_changes");
      expect(screen.getByRole("button", { name: /Request changes/ })).toBeTruthy();
    });
  }

  it("PLAN_GATE's description explains the plan goes back to the Architect", () => {
    render(<GatePanel taskId="task_1" gate="PLAN_GATE" provider={GITHUB_PROVIDER} />);
    expect(screen.getByText(/back to the Architect/)).toBeTruthy();
    expect(screen.getByText(/brief and the stories are kept/)).toBeTruthy();
  });
});
