import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Route-handler tests for repository connections, covering the optional
 * `context` field: creation with/without it, the length cap, that the list
 * endpoint reports only presence, and that the detail endpoint echoes the
 * full text.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-repos-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let reposRoute: typeof import("@/app/api/repos/route");
let repoRoute: typeof import("@/app/api/repos/[id]/route");

beforeAll(async () => {
  reposRoute = await import("@/app/api/repos/route");
  repoRoute = await import("@/app/api/repos/[id]/route");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function post(body: unknown) {
  return reposRoute.POST(
    new Request("http://test/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const VALID_BODY = {
  name: "acme/storefront",
  url: "https://github.com/acme/storefront",
  defaultBranch: "main",
};

describe("POST /api/repos", () => {
  it("creates without context when omitted", async () => {
    const response = await post(VALID_BODY);
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { repo: { context: string | null } };
    expect(payload.repo.context).toBeNull();
  });

  it("creates without context when sent as an empty string", async () => {
    const response = await post({ ...VALID_BODY, context: "" });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { repo: { context: string | null } };
    expect(payload.repo.context).toBeNull();
  });

  it("stores the supplied context", async () => {
    const context = "This project uses a modular monolith with a `src/server` layer.";
    const response = await post({ ...VALID_BODY, context });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as { repo: { context: string | null } };
    expect(payload.repo.context).toBe(context);
  });

  it("rejects context over the length cap with a field-level error", async () => {
    const response = await post({ ...VALID_BODY, context: "x".repeat(20_001) });
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { details?: Record<string, string> };
    expect(payload.details?.context).toBeTruthy();
  });
});

describe("GET /api/repos and /api/repos/:id", () => {
  it("reports presence only on the list endpoint, and the full text on the detail endpoint", async () => {
    const context = "Architecture notes for the agents.";
    const created = await post({ ...VALID_BODY, name: "acme/other", context });
    const { repo } = (await created.json()) as { repo: { id: string } };

    const list = await reposRoute.GET();
    const listPayload = (await list.json()) as {
      repos: Array<{ id: string; context?: string | null; hasContext: boolean }>;
    };
    const listed = listPayload.repos.find((entry) => entry.id === repo.id);
    expect(listed?.hasContext).toBe(true);
    expect(listed?.context).toBeUndefined();

    const detail = await repoRoute.GET(new Request("http://test/api/repos/x"), params(repo.id));
    const detailPayload = (await detail.json()) as { repo: { context: string | null } };
    expect(detailPayload.repo.context).toBe(context);
  });

  it("reports hasContext=false on the list endpoint when no context was set", async () => {
    const created = await post({ ...VALID_BODY, name: "acme/no-context" });
    const { repo } = (await created.json()) as { repo: { id: string } };

    const list = await reposRoute.GET();
    const listPayload = (await list.json()) as {
      repos: Array<{ id: string; context?: string | null; hasContext: boolean }>;
    };
    const listed = listPayload.repos.find((entry) => entry.id === repo.id);
    expect(listed?.hasContext).toBe(false);
    expect(listed?.context).toBeUndefined();
  });
});
