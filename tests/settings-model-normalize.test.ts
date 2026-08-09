import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * stories.md S3 — `models` changed shape from `Record<AgentStage, string>` to
 * `Record<AgentStage, { tier } | { literal }>`. `getSettings()` must read a
 * legacy blob of bare model strings (written before this change) as
 * `{ literal }` for every stage, without dropping any of them — the normalizer
 * has to run before the base/stored spread merge, or a stray string in a
 * `ModelSelection`'s position survives into `execute.ts` and throws mid-pipeline.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-model-normalize-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let store: typeof import("@/server/settings/store");
let AGENT_STAGES: typeof import("@/server/pipeline/stages").AGENT_STAGES;
let db: typeof import("@/server/db/client").db;
let settingsTable: typeof import("@/server/db/schema").settings;

/** Writes a raw settings row, simulating a blob saved before this story existed. */
function writeLegacyRow(value: unknown) {
  const json = JSON.stringify(value);
  db.insert(settingsTable)
    .values({ key: "app", value: json })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: json } })
    .run();
}

beforeAll(async () => {
  store = await import("@/server/settings/store");
  ({ AGENT_STAGES } = await import("@/server/pipeline/stages"));
  ({ db } = await import("@/server/db/client"));
  ({ settings: settingsTable } = await import("@/server/db/schema"));
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("getSettings — legacy bare-string models blob", () => {
  it("normalizes a legacy blob of bare model strings into { literal } for every stage", () => {
    const legacyModels = Object.fromEntries(
      AGENT_STAGES.map((stage) => [stage, `${stage.toLowerCase()}-legacy-model`]),
    );
    writeLegacyRow({ theme: "dark", models: legacyModels });

    const effective = store.getSettings();
    for (const stage of AGENT_STAGES) {
      expect(effective.models[stage]).toEqual({ literal: `${stage.toLowerCase()}-legacy-model` });
    }
  });

  it("leaves an already-normalized { tier } selection untouched", () => {
    writeLegacyRow({ models: { DEVELOPMENT: { tier: "heavy" } } });
    expect(store.getSettings().models.DEVELOPMENT).toEqual({ tier: "heavy" });
  });

  it("leaves an already-normalized { literal } selection untouched", () => {
    writeLegacyRow({ models: { QA: { literal: "gpt-4.1" } } });
    expect(store.getSettings().models.QA).toEqual({ literal: "gpt-4.1" });
  });

  it("a mixed legacy/normalized blob keeps every stage, converting only the bare strings", () => {
    writeLegacyRow({
      models: {
        DEVELOPMENT: "claude-sonnet-5",
        QA: { tier: "light" },
      },
    });

    const effective = store.getSettings();
    expect(effective.models.DEVELOPMENT).toEqual({ literal: "claude-sonnet-5" });
    expect(effective.models.QA).toEqual({ tier: "light" });
    // Every other stage still has a selection — nothing was dropped, they
    // fall back to `defaultSettings()`'s tier for a stage the legacy blob
    // never mentioned.
    for (const stage of AGENT_STAGES) {
      expect(effective.models[stage]).toBeDefined();
    }
  });

  it("an absent models key falls back to the default tier selections", () => {
    writeLegacyRow({ theme: "dark" });
    const effective = store.getSettings();
    expect(effective.models).toEqual(store.defaultSettings().models);
  });
});
