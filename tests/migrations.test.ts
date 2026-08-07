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

function tableExists(sqlite: Database.Database, table: string): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
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

  it("adds context to an existing repos table, defaulting to null", () => {
    const sqlite = freshDatabase("context.db");
    expect(columns(sqlite, "repos")).not.toContain("context");
    sqlite
      .prepare("INSERT INTO repos (id, name, url) VALUES ('r', 'acme', 'https://x/y')")
      .run();

    runMigrations(sqlite);

    expect(columns(sqlite, "repos")).toContain("context");
    const row = sqlite.prepare("SELECT context FROM repos WHERE id = 'r'").get() as {
      context: string | null;
    };
    expect(row.context).toBeNull();
    sqlite.close();
  });

  it("adds custom_branch_name to an existing tasks table", () => {
    const sqlite = freshDatabase("custom-branch-name.db");
    expect(columns(sqlite, "tasks")).not.toContain("custom_branch_name");

    runMigrations(sqlite);

    expect(columns(sqlite, "tasks")).toContain("custom_branch_name");
    sqlite.close();
  });

  it("adds the five verification columns to an existing repos table", () => {
    const sqlite = freshDatabase("verify-columns.db");
    for (const column of [
      "verify_install",
      "verify_build",
      "verify_test",
      "verify_lint",
      "verify_timeout_seconds",
    ]) {
      expect(columns(sqlite, "repos")).not.toContain(column);
    }
    sqlite
      .prepare("INSERT INTO repos (id, name, url) VALUES ('r', 'acme', 'https://x/y')")
      .run();

    runMigrations(sqlite);

    expect(columns(sqlite, "repos")).toContain("verify_install");
    expect(columns(sqlite, "repos")).toContain("verify_timeout_seconds");
    const row = sqlite
      .prepare("SELECT verify_install AS install, verify_timeout_seconds AS timeout FROM repos WHERE id = 'r'")
      .get() as { install: string | null; timeout: number };
    expect(row.install).toBeNull();
    expect(row.timeout).toBe(600);
    sqlite.close();
  });

  it("adds the four prompt/model/provider columns to an existing stage_runs table", () => {
    const sqlite = freshDatabase("prompt-columns.db");
    for (const column of ["system_prompt", "user_prompt", "model", "provider"]) {
      expect(columns(sqlite, "stage_runs")).not.toContain(column);
    }
    sqlite
      .prepare("INSERT INTO repos (id, name, url) VALUES ('r', 'acme', 'https://x/y')")
      .run();
    sqlite
      .prepare("INSERT INTO tasks (id, repo_id, title, description) VALUES ('t', 'r', 'Old', 'd')")
      .run();
    sqlite
      .prepare("INSERT INTO stage_runs (id, task_id, stage) VALUES ('run_1', 't', 'DEVELOPMENT')")
      .run();

    runMigrations(sqlite);

    for (const column of ["system_prompt", "user_prompt", "model", "provider"]) {
      expect(columns(sqlite, "stage_runs")).toContain(column);
    }
    const row = sqlite
      .prepare(
        "SELECT system_prompt AS systemPrompt, user_prompt AS userPrompt, model, provider FROM stage_runs WHERE id = 'run_1'",
      )
      .get() as { systemPrompt: string | null; userPrompt: string | null; model: string | null; provider: string | null };
    expect(row.systemPrompt).toBeNull();
    expect(row.userPrompt).toBeNull();
    expect(row.model).toBeNull();
    expect(row.provider).toBeNull();
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

  it("adds the attachments table to a database created before it existed", () => {
    // The attachments table is new: `bootstrap.sql.ts`'s `CREATE TABLE IF NOT
    // EXISTS` covers it directly, with no `migrations.ts` entry needed. This
    // simulates a database from before the table existed by bootstrapping with
    // the attachments DDL stripped out, then re-running the *current* bootstrap
    // SQL exactly as `client.ts` does on every process start.
    const preAttachmentsSql = BOOTSTRAP_SQL.replace(
      /CREATE TABLE IF NOT EXISTS attachments[\s\S]*?attachments_task_idx ON attachments\(task_id\);/,
      "",
    );
    expect(preAttachmentsSql).not.toContain("attachments");

    const sqlite = new Database(path.join(tempDir, "pre-attachments.db"));
    sqlite.exec(preAttachmentsSql);
    expect(tableExists(sqlite, "attachments")).toBe(false);

    sqlite.exec(BOOTSTRAP_SQL);

    expect(tableExists(sqlite, "attachments")).toBe(true);
    sqlite.close();
  });

  it("adds the task_dependencies table to a database created before it existed", () => {
    // Same story as attachments above: a new table needs only the bootstrap's
    // `CREATE TABLE IF NOT EXISTS`, not a `migrations.ts` entry.
    const preDependenciesSql = BOOTSTRAP_SQL.replace(
      /CREATE TABLE IF NOT EXISTS task_dependencies[\s\S]*?task_dependencies_depends_on_idx ON task_dependencies\(depends_on_task_id\);/,
      "",
    );
    expect(preDependenciesSql).not.toContain("task_dependencies");

    const sqlite = new Database(path.join(tempDir, "pre-dependencies.db"));
    sqlite.exec(preDependenciesSql);
    expect(tableExists(sqlite, "task_dependencies")).toBe(false);

    sqlite.exec(BOOTSTRAP_SQL);

    expect(tableExists(sqlite, "task_dependencies")).toBe(true);
    sqlite.close();
  });

  it("adds the verification_runs table to a database created before it existed", () => {
    // Same story as attachments/task_dependencies: a new table needs only the
    // bootstrap's `CREATE TABLE IF NOT EXISTS`, not a `migrations.ts` entry.
    const preVerificationRunsSql = BOOTSTRAP_SQL.replace(
      /CREATE TABLE IF NOT EXISTS verification_runs[\s\S]*?verification_runs_stage_run_idx ON verification_runs\(stage_run_id\);/,
      "",
    );
    expect(preVerificationRunsSql).not.toContain("verification_runs");

    const sqlite = new Database(path.join(tempDir, "pre-verification-runs.db"));
    sqlite.exec(preVerificationRunsSql);
    expect(tableExists(sqlite, "verification_runs")).toBe(false);

    sqlite.exec(BOOTSTRAP_SQL);

    expect(tableExists(sqlite, "verification_runs")).toBe(true);
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
