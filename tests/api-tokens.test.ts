import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * S8 §11 — the optional bearer-token gate on `/api/*` (`src/proxy.ts`) and
 * the token store/actor-attribution helpers it relies on
 * (`src/server/auth/tokens.ts`). Follows the temp-DB fixture pattern in
 * `tests/api-tasks-archive.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-tokens-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let tokens: typeof import("@/server/auth/tokens");
let proxyModule: typeof import("@/proxy");
let dbClient: typeof import("@/server/db/client");
let service: typeof import("@/server/tasks/service");
let tasksRoute: typeof import("@/app/api/tasks/route");
let eventsStore: typeof import("@/server/events/store");
let repoId: string;

beforeAll(async () => {
  tokens = await import("@/server/auth/tokens");
  proxyModule = await import("@/proxy");
  dbClient = await import("@/server/db/client");
  service = await import("@/server/tasks/service");
  tasksRoute = await import("@/app/api/tasks/route");
  eventsStore = await import("@/server/events/store");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;
});

afterAll(() => {
  dbClient.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const task of service.listTasks({ includeArchived: true })) service.deleteTask(task.id);
  dbClient.db.delete(dbClient.schema.apiTokens).run();
});

describe("token store", () => {
  it("never lets a raw secret round-trip back out — only the hash is stored", () => {
    const secret = tokens.generateTokenSecret();
    tokens.createApiToken("CI", secret);

    const rows = dbClient.db.select().from(dbClient.schema.apiTokens).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(secret);
    expect(rows[0].name).toBe("CI");
  });

  it("verifies the correct secret and rejects a wrong one", () => {
    const secret = tokens.generateTokenSecret();
    tokens.createApiToken("CI", secret);

    expect(tokens.verifyBearerToken(secret)).toEqual({ id: expect.any(String), name: "CI" });
    expect(tokens.verifyBearerToken("wrong-secret")).toBeNull();
  });

  it("stamps last_used_at only on a successful verification", () => {
    const secret = tokens.generateTokenSecret();
    tokens.createApiToken("CI", secret);
    const before = dbClient.db.select().from(dbClient.schema.apiTokens).all()[0];
    expect(before.lastUsedAt).toBeNull();

    tokens.verifyBearerToken(secret);
    const after = dbClient.db.select().from(dbClient.schema.apiTokens).all()[0];
    expect(after.lastUsedAt).not.toBeNull();
  });

  it("hasConfiguredTokens is false until a token exists", () => {
    expect(tokens.hasConfiguredTokens()).toBe(false);
    tokens.createApiToken("CI", tokens.generateTokenSecret());
    expect(tokens.hasConfiguredTokens()).toBe(true);
  });
});

describe("proxy: /api/* gate", () => {
  it("passes every request through untouched when no token is configured", () => {
    expect(tokens.hasConfiguredTokens()).toBe(false);
    const response = proxyModule.proxy(new NextRequest("http://test/api/tasks"));
    expect(response.status).not.toBe(401);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("401s a request with no Authorization header once a token is configured", () => {
    tokens.createApiToken("CI", tokens.generateTokenSecret());
    const response = proxyModule.proxy(new NextRequest("http://test/api/tasks"));
    expect(response.status).toBe(401);
  });

  it("401s a request bearing the wrong token", () => {
    tokens.createApiToken("CI", tokens.generateTokenSecret());
    const response = proxyModule.proxy(
      new NextRequest("http://test/api/tasks", {
        headers: { authorization: "Bearer not-the-secret" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("lets the correct token through and tags the forwarded request with the token's name", () => {
    const secret = tokens.generateTokenSecret();
    tokens.createApiToken("CI", secret);
    const response = proxyModule.proxy(
      new NextRequest("http://test/api/tasks", {
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(response.status).not.toBe(401);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-api-token-name")).toBe("CI");
  });
});

describe("no-token regression: /api/tasks behaves exactly as before this feature", () => {
  it("POST /api/tasks succeeds with no Authorization header when the route is called directly", async () => {
    // Tests exercise route handlers directly (as every other API test in this
    // suite does) — the point of this case is that the *route* itself never
    // demands a header; enforcement is entirely `proxy.ts`'s job, and with no
    // token configured `proxy.ts` never blocks anything (covered above).
    expect(tokens.hasConfiguredTokens()).toBe(false);
    const response = await tasksRoute.POST(
      new Request("http://test/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId,
          title: "Untouched by auth",
          description: "A description long enough to pass validation upstream.",
          priority: "medium",
        }),
      }),
    );
    expect(response.status).toBe(201);
  });
});

describe("actor attribution", () => {
  it("records the token's name on the event a token-authenticated request produces", async () => {
    const response = await tokens.withActorFromRequest(
      new Request("http://test", { headers: { "x-api-token-name": "CI" } }),
      () =>
        tasksRoute.POST(
          new Request("http://test/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoId,
              title: "Triggered by CI",
              description: "A description long enough to pass validation upstream.",
              priority: "medium",
            }),
          }),
        ),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { task: { id: string } };

    const events = eventsStore
      .readEventsSince(0)
      .filter((event) => event.taskId === created.task.id && event.type === "task_created");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("CI");
  });

  it("leaves actor null for a browser-originated request (no x-api-token-name header)", async () => {
    const response = await tasksRoute.POST(
      new Request("http://test/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId,
          title: "Triggered by a human",
          description: "A description long enough to pass validation upstream.",
          priority: "medium",
        }),
      }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { task: { id: string } };

    const events = eventsStore
      .readEventsSince(0)
      .filter((event) => event.taskId === created.task.id && event.type === "task_created");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBeNull();
  });
});
