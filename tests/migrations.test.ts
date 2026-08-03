import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration runner.
 *
 * The bootstrap DDL uses `CREATE TABLE IF NOT EXISTS`, which does nothing to a
 * table that already exists. These tests cover the case that matters: an
 * existing database created before a column was added.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"));

let BOOTSTRAP_SQL: string;
let runMigrations: typeof import("@/server/db/migrations").runMigrations;
let SCHEMA_VERSION: number;

beforeAll(async () => {
  ({ BOOTSTRAP_SQL } = await import("@/server/db/bootstrap.sql"));
  ({ runMigrations, SCHEMA_VERSION } = await import("@/server/db/migrations"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function columns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function version(sqlite: Database.Database): number {
  return (sqlite.pragma("user_version") as Array<{ user_version: number }>)[0].user_version;
}

/** A database created by the bootstrap alone, as an older build would leave it. */
function freshDatabase(name: string): Database.Database {
  const sqlite = new Database(path.join(tempDir, name));
  sqlite.exec(BOOTSTRAP_SQL);
  return sqlite;
}

describe("runMigrations", () => {
  it("brings a bootstrap-only database to the current version", () => {
    const sqlite = freshDatabase("fresh.db");
    expect(version(sqlite)).toBe(0);

    const result = runMigrations(sqlite);

    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);
    expect(version(sqlite)).toBe(SCHEMA_VERSION);
    sqlite.close();
  });

  it("adds require_human_code_review to an existing tasks table", () => {
    const sqlite = freshDatabase("existing.db");
    // The bootstrap does not create it — that is the whole reason migrations
    // exist rather than editing the bootstrap DDL.
    expect(columns(sqlite, "tasks")).not.toContain("require_human_code_review");

    runMigrations(sqlite);

    expect(columns(sqlite, "tasks")).toContain("require_human_code_review");
    sqlite.close();
  });

  it("defaults the new column to false on rows that predate it", () => {
    const sqlite = freshDatabase("rows.db");
    sqlite
      .prepare("INSERT INTO repos (id, name, url) VALUES ('r', 'acme', 'https://x/y')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO tasks (id, repo_id, title, description) VALUES ('t', 'r', 'Old', 'd')",
      )
      .run();

    runMigrations(sqlite);

    const row = sqlite
      .prepare("SELECT require_human_code_review AS flag FROM tasks WHERE id = 't'")
      .get() as { flag: number };
    expect(row.flag).toBe(0);
    sqlite.close();
  });

  it("is a no-op when run again", () => {
    const sqlite = freshDatabase("twice.db");
    runMigrations(sqlite);

    const second = runMigrations(sqlite);

    expect(second.applied).toEqual([]);
    expect(second.from).toBe(SCHEMA_VERSION);
    expect(version(sqlite)).toBe(SCHEMA_VERSION);
    sqlite.close();
  });

  it("re-running a migration on a half-applied database is harmless", () => {
    // Simulates a crash between the ALTER and the version bump.
    const sqlite = freshDatabase("half.db");
    sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN require_human_code_review INTEGER NOT NULL DEFAULT 0",
    );
    expect(version(sqlite)).toBe(0);

    expect(() => runMigrations(sqlite)).not.toThrow();
    expect(version(sqlite)).toBe(SCHEMA_VERSION);
    sqlite.close();
  });
});
