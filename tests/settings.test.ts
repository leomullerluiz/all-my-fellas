import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Route-handler tests for `GET`/`PATCH /api/settings`, focused on the `theme`
 * field (S1). Called directly, same pattern as `tests/api-tasks.test.ts`.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let store: typeof import("@/server/settings/store");
let settingsRoute: typeof import("@/app/api/settings/route");

beforeAll(async () => {
  store = await import("@/server/settings/store");
  settingsRoute = await import("@/app/api/settings/route");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  store.updateSettings({ theme: "system" });
});

function patch(body: unknown) {
  return settingsRoute.PATCH(
    new Request("http://test/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("theme setting", () => {
  it("defaults to system", () => {
    expect(store.defaultSettings().theme).toBe("system");
  });

  it("GET exposes the currently stored theme", async () => {
    store.updateSettings({ theme: "dark" });

    const response = await settingsRoute.GET();
    const payload = (await response.json()) as { settings: { theme: string } };
    expect(payload.settings.theme).toBe("dark");
  });

  it("PATCH persists a valid theme and GET reflects it afterwards", async () => {
    const response = await patch({ theme: "light" });
    expect(response.status).toBe(200);

    const getResponse = await settingsRoute.GET();
    const payload = (await getResponse.json()) as { settings: { theme: string } };
    expect(payload.settings.theme).toBe("light");
  });

  it("PATCH rejects an invalid theme and leaves the stored value untouched", async () => {
    store.updateSettings({ theme: "dark" });

    const response = await patch({ theme: "solarized" });
    expect(response.status).toBe(400);

    expect(store.getSettings().theme).toBe("dark");
  });

  it("is read fresh from the store, not cached in memory", () => {
    store.updateSettings({ theme: "light" });
    expect(store.getSettings().theme).toBe("light");

    store.updateSettings({ theme: "dark" });
    expect(store.getSettings().theme).toBe("dark");
  });
});
