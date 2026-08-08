import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { resolveDatabaseFile } from "../config/env";
import { BOOTSTRAP_SQL } from "./bootstrap.sql";
import { runMigrations } from "./migrations";
import * as schema from "./schema";

/**
 * Shared SQLite handle for the Next.js server and the worker.
 *
 * WAL plus a busy timeout is what makes two writer processes on one file
 * workable; without it the second process fails immediately with SQLITE_BUSY.
 */

export type AppDatabase = ReturnType<typeof createDatabase>;

function createDatabase() {
  const file = resolveDatabaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  // Set before any other statement: the bootstrap DDL itself can contend with
  // another process that is opening the same file at the same moment.
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(BOOTSTRAP_SQL);
  // The bootstrap creates missing tables; migrations evolve existing ones.
  runMigrations(sqlite);

  return drizzle(sqlite, { schema });
}

/**
 * Next.js dev mode re-evaluates modules on every edit, and `next build` spawns
 * several worker processes that merely import this module while collecting page
 * data. Both are reasons not to connect eagerly: the handle is created on first
 * use and cached on `globalThis`.
 */
const globalForDb = globalThis as unknown as { __pipelineDb?: AppDatabase };

function getDatabase(): AppDatabase {
  globalForDb.__pipelineDb ??= createDatabase();
  return globalForDb.__pipelineDb;
}

/**
 * Lazily-connected Drizzle instance.
 *
 * The proxy forwards every access to the real handle, so callers use it exactly
 * like a normal `drizzle()` result while the connection itself is deferred to
 * the first query.
 */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, property, receiver) {
    return Reflect.get(getDatabase(), property, receiver);
  },
  has(_target, property) {
    return Reflect.has(getDatabase(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(getDatabase());
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(getDatabase(), property);
  },
});

/**
 * Closes the connection, if one was ever opened.
 *
 * Used by tests and by the worker's shutdown path; on Windows the file cannot
 * be deleted while a handle is open.
 */
export function closeDatabase(): void {
  const instance = globalForDb.__pipelineDb;
  if (!instance) return;
  instance.$client.close();
  globalForDb.__pipelineDb = undefined;
}

/**
 * Rewrites the database file to reclaim space the retention sweep freed.
 *
 * Never called automatically — `VACUUM` takes an exclusive lock on the whole
 * file, which is exactly what a two-process WAL setup (this web process and
 * the worker) must not hit on a timer. Settings offers this as an explicit,
 * separately-triggered button instead. See spec-audit-trail.md §11.
 */
export function vacuumDatabase(): void {
  getDatabase().$client.exec("VACUUM");
}

export { schema };
