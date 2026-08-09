/**
 * Idempotent DDL applied on every process start.
 *
 * Two processes (web + worker) share one SQLite file and there is no migration
 * runner in the hot path, so the schema is created with `IF NOT EXISTS`
 * statements that are safe to run concurrently. `drizzle-kit push` remains
 * available for schema evolution during development.
 */
export const BOOTSTRAP_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT NOT NULL DEFAULT 'CREATED',
  priority TEXT NOT NULL DEFAULT 'medium',
  difficulty TEXT,
  criticality TEXT,
  branch_name TEXT,
  pr_url TEXT,
  workspace_path TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_stage_idx ON tasks(current_stage);

CREATE TABLE IF NOT EXISTS stage_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at INTEGER,
  finished_at INTEGER,
  max_turns INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS stage_runs_task_idx ON stage_runs(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS stage_runs_task_stage_attempt_idx
  ON stage_runs(task_id, stage, attempt);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content_md TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS artifacts_task_type_idx ON artifacts(task_id, type);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments(task_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
  session_id TEXT,
  transcript_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS agent_runs_stage_run_idx ON agent_runs(stage_run_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_run_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS events_task_seq_idx ON events(task_id, seq);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT,
  decided_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_pair_idx
  ON task_dependencies(task_id, depends_on_task_id);
CREATE INDEX IF NOT EXISTS task_dependencies_task_idx ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS task_dependencies_depends_on_idx ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS verification_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  stdout_tail TEXT NOT NULL DEFAULT '',
  stderr_tail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS verification_runs_task_idx ON verification_runs(task_id);
CREATE INDEX IF NOT EXISTS verification_runs_stage_run_idx ON verification_runs(stage_run_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Optional bearer tokens for /api/* (§11). Empty table means the API stays
-- open, exactly as before this shipped — see server/auth/tokens.ts.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  run_after INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS jobs_status_run_after_idx ON jobs(status, run_after);

-- Single-row liveness signal (§7.2). A dedicated table rather than a
-- 'settings' key: the worker rewrites this every tick (and on its own
-- interval while a job is in flight), and conflating that churn with
-- user-preference reads/writes would touch a row neither process actually
-- cares about together.
CREATE TABLE IF NOT EXISTS worker_status (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  pid INTEGER,
  version TEXT,
  active_job_id TEXT,
  active_task_id TEXT
);
`;
