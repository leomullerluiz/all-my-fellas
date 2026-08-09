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
  store.updateSettings({
    theme: "system",
    providers: store.defaultSettings().providers,
    quotaLimits: {
      subscription: { limitUsd: null, cadence: "daily" },
      api_key: { limitUsd: null, cadence: "daily" },
    },
  });
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

describe("no-approval automation setting (S1)", () => {
  it("defaults to false", () => {
    expect(store.defaultSettings().noApprovalAutomation).toBe(false);
  });

  it("PATCH persists true and GET reflects it afterwards", async () => {
    const response = await patch({ noApprovalAutomation: true });
    expect(response.status).toBe(200);

    const getResponse = await settingsRoute.GET();
    const payload = (await getResponse.json()) as { settings: { noApprovalAutomation: boolean } };
    expect(payload.settings.noApprovalAutomation).toBe(true);

    // Round-trip back to false, mirroring the unchanged-default path every
    // other settings field is exercised by.
    const back = await patch({ noApprovalAutomation: false });
    expect(back.status).toBe(200);
    expect(store.getSettings().noApprovalAutomation).toBe(false);
  });
});

describe("LLM provider per role (S3)", () => {
  it("defaults every stage to claude", () => {
    const defaults = store.defaultSettings();
    for (const stage of Object.keys(defaults.providers) as Array<keyof typeof defaults.providers>) {
      expect(defaults.providers[stage]).toBe("claude");
    }
  });

  it("GET exposes providers alongside models and maxTurns", async () => {
    const response = await settingsRoute.GET();
    const payload = (await response.json()) as {
      settings: { providers: Record<string, string>; models: Record<string, string> };
    };
    expect(payload.settings.providers.PO_REFINEMENT).toBe("claude");
    expect(payload.settings.models.PO_REFINEMENT).toBeTruthy();
  });

  it("PATCH updates one stage's provider without touching the others", async () => {
    const response = await patch({ providers: { PO_REFINEMENT: "chatgpt" } });
    expect(response.status).toBe(200);

    const settingsNow = store.getSettings();
    expect(settingsNow.providers.PO_REFINEMENT).toBe("chatgpt");
    expect(settingsNow.providers.DEVELOPMENT).toBe("claude");
  });

  it("PATCH rejects an unknown provider id", async () => {
    const response = await patch({ providers: { PO_REFINEMENT: "bard" } });
    expect(response.status).toBe(400);
  });

  it("PATCH accepts a provider selection with no credential configured", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const response = await patch({ providers: { PO_REFINEMENT: "chatgpt" } });
      expect(response.status).toBe(200);

      const getResponse = await settingsRoute.GET();
      const payload = (await getResponse.json()) as {
        llmCredentials: Record<string, { mode: string }>;
      };
      expect(payload.llmCredentials.chatgpt.mode).toBe("missing");
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("defaults a settings row stored before `providers` existed to claude on every stage", async () => {
    const { db } = await import("@/server/db/client");
    const { settings: settingsTable } = await import("@/server/db/schema");

    // Simulate a pre-migration row: a stored blob with no `providers` key at all.
    const legacyBlob = JSON.stringify({ theme: "dark", models: { PO_REFINEMENT: "claude-sonnet-5" } });
    db.insert(settingsTable)
      .values({ key: "app", value: legacyBlob })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: legacyBlob } })
      .run();

    const effective = store.getSettings();
    for (const stage of Object.keys(effective.providers) as Array<keyof typeof effective.providers>) {
      expect(effective.providers[stage]).toBe("claude");
    }
  });
});

describe("quota limits setting", () => {
  it("defaults to unset limits with a daily cadence", () => {
    const defaults = store.defaultSettings().quotaLimits;
    expect(defaults.subscription).toEqual({ limitUsd: null, cadence: "daily" });
    expect(defaults.api_key).toEqual({ limitUsd: null, cadence: "daily" });
  });

  it("PATCH persists one mode's limit without dropping the other's", async () => {
    const response = await patch({
      quotaLimits: { subscription: { limitUsd: 25, cadence: "hourly" } },
    });
    expect(response.status).toBe(200);

    const settings = store.getSettings();
    expect(settings.quotaLimits.subscription).toEqual({ limitUsd: 25, cadence: "hourly" });
    expect(settings.quotaLimits.api_key).toEqual({ limitUsd: null, cadence: "daily" });
  });

  it("PATCH accepts a null limitUsd to clear a configured quota", async () => {
    await patch({ quotaLimits: { api_key: { limitUsd: 10, cadence: "daily" } } });
    const response = await patch({
      quotaLimits: { api_key: { limitUsd: null, cadence: "daily" } },
    });
    expect(response.status).toBe(200);
    expect(store.getSettings().quotaLimits.api_key.limitUsd).toBeNull();
  });

  it("PATCH rejects an invalid cadence and leaves the stored value untouched", async () => {
    await patch({ quotaLimits: { subscription: { limitUsd: 5, cadence: "daily" } } });

    const response = await patch({
      quotaLimits: { subscription: { limitUsd: 5, cadence: "weekly" } },
    });
    expect(response.status).toBe(400);

    expect(store.getSettings().quotaLimits.subscription).toEqual({
      limitUsd: 5,
      cadence: "daily",
    });
  });

  it("PATCH rejects a negative limit", async () => {
    const response = await patch({
      quotaLimits: { subscription: { limitUsd: -1, cadence: "daily" } },
    });
    expect(response.status).toBe(400);
  });
});

describe("quota enforcement setting (S2)", () => {
  it("defaults to off, so an existing installation's behaviour is unchanged", () => {
    expect(store.defaultSettings().quotaEnforcement).toBe("off");
  });

  it("PATCH persists a valid enforcement mode", async () => {
    const response = await patch({ quotaEnforcement: "hold" });
    expect(response.status).toBe(200);
    expect(store.getSettings().quotaEnforcement).toBe("hold");
  });

  it("PATCH rejects an unknown enforcement mode", async () => {
    const response = await patch({ quotaEnforcement: "block" });
    expect(response.status).toBe(400);
  });
});

describe("per-stage spend ceiling setting (S3)", () => {
  it("defaults to null — no ceiling", () => {
    expect(store.defaultSettings().maxCostPerStageUsd).toBeNull();
  });

  it("PATCH persists a positive ceiling and PATCH null clears it", async () => {
    const response = await patch({ maxCostPerStageUsd: 5 });
    expect(response.status).toBe(200);
    expect(store.getSettings().maxCostPerStageUsd).toBe(5);

    const cleared = await patch({ maxCostPerStageUsd: null });
    expect(cleared.status).toBe(200);
    expect(store.getSettings().maxCostPerStageUsd).toBeNull();
  });

  it("PATCH rejects a negative ceiling", async () => {
    const response = await patch({ maxCostPerStageUsd: -1 });
    expect(response.status).toBe(400);
  });
});

describe("reworkMaxCycles / humanCodeReviewDefault PATCH (bug fix)", () => {
  // `updateSettingsSchema` used to declare `qaMaxCycles`, which matches no
  // field on `AppSettings` (the field is `reworkMaxCycles`) — `z.object`
  // silently strips unknown keys, so a `reworkMaxCycles` PATCH was discarded
  // before this fix. `humanCodeReviewDefault` was not declared at all.

  it("PATCH actually updates reworkMaxCycles", async () => {
    const response = await patch({ reworkMaxCycles: 4 });
    expect(response.status).toBe(200);
    expect(store.getSettings().reworkMaxCycles).toBe(4);
  });

  it("PATCH actually updates humanCodeReviewDefault", async () => {
    const response = await patch({ humanCodeReviewDefault: true });
    expect(response.status).toBe(200);
    expect(store.getSettings().humanCodeReviewDefault).toBe(true);
  });
});
