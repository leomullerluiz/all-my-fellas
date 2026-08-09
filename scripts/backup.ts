import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { resolveDatabaseFile } from "../src/server/config/env";
import { closeDatabase, db } from "../src/server/db/client";

/**
 * `npm run db:backup` — `spec-board-at-scale.md` §10.
 *
 * Uses `better-sqlite3`'s online backup API (`db.$client.backup`, the same
 * handle `closeDatabase`/`vacuumDatabase` already reach into) rather than a
 * plain file copy: the online backup API is safe against a live WAL
 * database, which matters because the worker may be writing to it while this
 * runs. Writes a timestamped file so a repeated run never overwrites a
 * previous backup.
 *
 * Deliberately has no restore counterpart anywhere in the product — see
 * §10's "No restore button". Restore stays a documented, offline file copy
 * with both processes stopped.
 */
async function main(): Promise<void> {
  const sourceFile = resolveDatabaseFile();
  const backupDir = path.join(path.dirname(sourceFile), "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupDir, `pipeline-${timestamp}.db`);

  console.log(`[db:backup] ${sourceFile} -> ${destination}`);
  await db.$client.backup(destination);
  console.log("[db:backup] done.");
}

main()
  .catch((error) => {
    console.error("[db:backup] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
