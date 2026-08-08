// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S5 — the dashboard's setup notice gains a problem entry when the worker's
 * health is not `healthy` (§7.4), in the same list as the credential
 * warnings. Each non-healthy state is rendered here against a real (but
 * repo-less) temp DB, with `resolveWorkerHealth` mocked to each derived
 * state in turn — `tests/health.test.ts` already covers the derivation
 * itself.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-worker-health-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const resolveWorkerHealth = vi.fn();
vi.mock("@/server/worker/health", () => ({ resolveWorkerHealth: () => resolveWorkerHealth() }));

let DashboardPage: typeof import("@/app/(dashboard)/page").default;

beforeAll(async () => {
  ({ default: DashboardPage } = await import("@/app/(dashboard)/page"));
});

afterEach(() => {
  cleanup();
  resolveWorkerHealth.mockReset();
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function renderDashboard() {
  const element = await DashboardPage({ searchParams: Promise.resolve({}) });
  render(element);
}

describe("dashboard setup notice — worker health (S5)", () => {
  it("shows no worker problem when healthy", async () => {
    resolveWorkerHealth.mockReturnValue({ state: "healthy", lagMs: 500, activeTaskId: null, interrupted: false });
    await renderDashboard();
    expect(screen.queryByText(/worker/i)).toBeNull();
  });

  it("reports 'never started' as a setup problem", async () => {
    resolveWorkerHealth.mockReturnValue({
      state: "never_started",
      lagMs: null,
      activeTaskId: null,
      interrupted: false,
    });
    await renderDashboard();
    expect(screen.getByText(/setup incomplete/i)).toBeTruthy();
    expect(screen.getByText(/never reported in/i)).toBeTruthy();
  });

  it("reports 'lagging' as a setup problem", async () => {
    resolveWorkerHealth.mockReturnValue({ state: "lagging", lagMs: 45_000, activeTaskId: null, interrupted: false });
    await renderDashboard();
    expect(screen.getByText(/hasn't reported in for a bit/i)).toBeTruthy();
  });

  it("reports 'stale' as a setup problem, naming the interrupted task", async () => {
    resolveWorkerHealth.mockReturnValue({
      state: "stale",
      lagMs: 120_000,
      activeTaskId: "task_42",
      interrupted: true,
    });
    await renderDashboard();
    expect(screen.getByText(/died while running task task_42/i)).toBeTruthy();
  });
});
