import type { Database } from "better-sqlite3";

/**
 * Schema migrations beyond the initial bootstrap.
 *
 * `bootstrap.sql.ts` uses `CREATE TABLE IF NOT EXISTS`, which creates a fresh
 * database but silently does nothing to an existing one. Anything that changes
 * an existing table has to live here instead.
 *
 * Versioning uses SQLite's built-in `PRAGMA user_version`, which needs no extra
 * table and cannot drift from the file it describes. Migration `n` in the array
 * takes the database from `user_version = n` to `n + 1`.
 *
 * Rules for adding one:
 * - Append only. Never edit or reorder an existing entry — a database that has
 *   already run it will not run it again.
 * - Keep each migration idempotent where cheap (see `addColumn`), so a database
 *   left half-migrated by a crash can be re-run safely.
 */

type Migration = {
  /** Short description, surfaced in the startup log. */
  readonly name: string;
  readonly up: (sqlite: Database) => void;
};

/** Adds a column only when it is missing, so re-running is harmless. */
function addColumn(
  sqlite: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const MIGRATIONS: readonly Migration[] = [
  {
    name: "task opt-in for the human code review gate",
    up: (sqlite) => {
      addColumn(
        sqlite,
        "tasks",
        "require_human_code_review",
        "INTEGER NOT NULL DEFAULT 0",
      );
    },
  },
  {
    name: "per-connection repository credentials and API base",
    up: (sqlite) => {
      // The environment variable NAME the connection reads. Never the value:
      // secrets stay out of the database.
      addColumn(sqlite, "repos", "credential_ref", "TEXT");
      // Overrides the provider's default Basic-auth username, for credentials
      // that need a real account name (Bitbucket app passwords, Gitea).
      addColumn(sqlite, "repos", "credential_username", "TEXT");
      // Self-hosted GitLab, Gitea, Azure DevOps Server.
      addColumn(sqlite, "repos", "api_base_url", "TEXT");
    },
  },
  {
    name: "optional free-text project context on repositories",
    up: (sqlite) => {
      addColumn(sqlite, "repos", "context", "TEXT");
    },
  },
  {
    name: "optional developer-chosen branch name at task creation",
    up: (sqlite) => {
      // The branch actually checked out (`branch_name`) is still populated
      // lazily by `prepareWorkspace`; this column records what was asked for,
      // at creation time, whether or not the task ever gets that far.
      addColumn(sqlite, "tasks", "custom_branch_name", "TEXT");
    },
  },
  {
    name: "per-repository verification commands",
    up: (sqlite) => {
      // `NULL` means "no such command" — see `createRepoSchema`'s command
      // field, which normalises a cleared form field to `undefined` so it
      // never reaches this column as `''`.
      addColumn(sqlite, "repos", "verify_install", "TEXT");
      addColumn(sqlite, "repos", "verify_build", "TEXT");
      addColumn(sqlite, "repos", "verify_test", "TEXT");
      addColumn(sqlite, "repos", "verify_lint", "TEXT");
      // A NOT NULL column needs a default to be addable by ALTER TABLE in
      // SQLite; 600s matches `VerificationOutcome`'s runner default.
      addColumn(sqlite, "repos", "verify_timeout_seconds", "INTEGER NOT NULL DEFAULT 600");
    },
  },
  {
    name: "terminal cause and per-task rework grant",
    up: (sqlite) => {
      addColumn(sqlite, "tasks", "failed_stage", "TEXT");
      addColumn(sqlite, "tasks", "failure_kind", "TEXT");
      addColumn(sqlite, "tasks", "rework_budget_grant", "INTEGER NOT NULL DEFAULT 0");

      // Backfill, once, from the heuristic retry used to rely on at runtime —
      // see `spec-retry-recovery.md` §4.5. A `FAILED` row with no matching
      // `stage_runs` row is left `NULL`; retry refuses those explicitly
      // (`no_failed_stage`) rather than guessing forever.
      sqlite.exec(`
        UPDATE tasks
           SET failed_stage = (
                 SELECT r.stage FROM stage_runs r
                  WHERE r.task_id = tasks.id AND r.status = 'failed'
               ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1
               ),
               failure_kind = 'stage_error'
         WHERE current_stage = 'FAILED';
      `);
    },
  },
  {
    name: "prompt, model and provider captured per stage run",
    up: (sqlite) => {
      // All four nullable: a row written before this migration never had a
      // prompt, and inventing one would be a lie — see spec-audit-trail.md §4.
      addColumn(sqlite, "stage_runs", "system_prompt", "TEXT");
      addColumn(sqlite, "stage_runs", "user_prompt", "TEXT");
      addColumn(sqlite, "stage_runs", "model", "TEXT");
      addColumn(sqlite, "stage_runs", "provider", "TEXT");
    },
  },
  {
    name: "distinguish an opened change request from a pushed branch",
    up: (sqlite) => {
      // `'created'` | `'manual'` — see `schema.ts`'s `tasks.deliveryOutcome`
      // comment for what each means to `pr_url`.
      addColumn(sqlite, "tasks", "delivery_outcome", "TEXT");
      addColumn(sqlite, "tasks", "delivery_reason", "TEXT");
      addColumn(sqlite, "tasks", "pr_number", "INTEGER");
      addColumn(sqlite, "tasks", "pr_state", "TEXT");

      // Backfill, once: a row delivered before this migration has `pr_url` set
      // but no `delivery_outcome`, and both the link (`created`) and the banner
      // (`manual`) branches on `tasks/[id]/page.tsx` require it to be non-NULL —
      // without this, a working pull request link would silently vanish from
      // the UI. `'created'` is the only guessable value: it cannot recover
      // which historical links were actually manual compare pages, but that is
      // strictly better than every one of them disappearing. Same precedent as
      // the `failed_stage`/`failure_kind` backfill above.
      sqlite.exec(`
        UPDATE tasks
           SET delivery_outcome = 'created'
         WHERE pr_url IS NOT NULL AND delivery_outcome IS NULL;
      `);
    },
  },
];

export type MigrationResult = { from: number; to: number; applied: string[] };

/**
 * Brings the database up to the current schema version.
 *
 * Each migration runs in its own transaction together with the version bump, so
 * a failure leaves the database at the last fully applied version rather than
 * half-way through one.
 */
export function runMigrations(sqlite: Database): MigrationResult {
  const [{ user_version: startingVersion }] = sqlite.pragma("user_version") as Array<{
    user_version: number;
  }>;

  const applied: string[] = [];

  for (let version = startingVersion; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version];
    const run = sqlite.transaction(() => {
      migration.up(sqlite);
      // `PRAGMA user_version` does not accept a bound parameter.
      sqlite.pragma(`user_version = ${version + 1}`);
    });
    run();
    applied.push(migration.name);
  }

  return { from: startingVersion, to: MIGRATIONS.length, applied };
}

/** Current schema version this build expects. Exported for diagnostics. */
export const SCHEMA_VERSION = MIGRATIONS.length;
