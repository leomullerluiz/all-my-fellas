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

describe("POST /api/repos — verification command detection", () => {
  it("still succeeds, with empty suggestions, when the detection clone cannot reach the host", async () => {
    const response = await post({ ...VALID_BODY, name: "acme/unreachable" });
    expect(response.status).toBe(201);

    const payload = (await response.json()) as {
      suggestedCommands?: Record<string, string>;
      repo: { verifyInstall: string | null; verifyBuild: string | null };
    };
    // Detection never writes to the row — only the response carries a
    // suggestion, and even that is empty here since there is no real host.
    expect(payload.suggestedCommands).toEqual({});
    expect(payload.repo.verifyInstall).toBeNull();
    expect(payload.repo.verifyBuild).toBeNull();
  });
});

describe("PATCH /api/repos/:id", () => {
  async function createRepo(name: string) {
    const created = await post({ ...VALID_BODY, name });
    const { repo } = (await created.json()) as { repo: { id: string } };
    return repo.id;
  }

  function patch(id: string, body: unknown) {
    return repoRoute.PATCH(
      new Request(`http://test/api/repos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(id),
    );
  }

  it("updates only the verification fields", async () => {
    const id = await createRepo("acme/verify-1");

    const response = await patch(id, {
      verifyInstall: "npm ci",
      verifyBuild: "npm run build",
      verifyTest: "npm test",
      verifyLint: "npm run lint",
      verifyTimeoutSeconds: 900,
    });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      repo: {
        verifyInstall: string | null;
        verifyBuild: string | null;
        verifyTest: string | null;
        verifyLint: string | null;
        verifyTimeoutSeconds: number;
        url: string;
      };
    };
    expect(payload.repo.verifyInstall).toBe("npm ci");
    expect(payload.repo.verifyBuild).toBe("npm run build");
    expect(payload.repo.verifyTest).toBe("npm test");
    expect(payload.repo.verifyLint).toBe("npm run lint");
    expect(payload.repo.verifyTimeoutSeconds).toBe(900);
    expect(payload.repo.url).toBe(VALID_BODY.url);
  });

  it("rejects a body carrying url or credentialRef with a 400, updating nothing", async () => {
    const id = await createRepo("acme/verify-2");

    const response = await patch(id, {
      verifyInstall: "npm ci",
      url: "https://github.com/acme/hijacked",
    });
    expect(response.status).toBe(400);

    const detail = await repoRoute.GET(new Request("http://test/api/repos/x"), params(id));
    const detailPayload = (await detail.json()) as {
      repo: { verifyInstall: string | null; url: string };
    };
    expect(detailPayload.repo.verifyInstall).toBeNull();
    expect(detailPayload.repo.url).toBe(VALID_BODY.url);
  });

  it("rejects a command containing shell syntax", async () => {
    const id = await createRepo("acme/verify-3");

    const response = await patch(id, { verifyBuild: "npm run build && npm run extra" });
    expect(response.status).toBe(400);
  });

  it("normalises an empty string to null, clearing a previously-set command", async () => {
    const id = await createRepo("acme/verify-4");
    await patch(id, { verifyInstall: "npm ci" });

    const response = await patch(id, { verifyInstall: "" });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { repo: { verifyInstall: string | null } };
    expect(payload.repo.verifyInstall).toBeNull();
  });

  it("rejects a timeout outside [30, 3600]", async () => {
    const id = await createRepo("acme/verify-5");

    const tooLow = await patch(id, { verifyTimeoutSeconds: 10 });
    expect(tooLow.status).toBe(400);

    const tooHigh = await patch(id, { verifyTimeoutSeconds: 10_000 });
    expect(tooHigh.status).toBe(400);
  });

  it("404s for an unknown repository", async () => {
    const response = await patch("repo_does_not_exist", { verifyInstall: "npm ci" });
    expect(response.status).toBe(404);
  });
});
