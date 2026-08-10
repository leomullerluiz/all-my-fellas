import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `spec-board-at-scale.md` §10 — `db.$client.backup(path)`, the online
 * backup API `npm run db:backup` (`scripts/backup.ts`) wraps, must stay safe
 * against a database a second connection is actively writing to. This
 * exercises the API directly rather than the script (which owns only
 * argv/file-path plumbing around the same call) with a concurrent writer
 * running for the duration of the backup.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-backup-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let dbClient: typeof import("@/server/db/client");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  dbClient = await import("@/server/db/client");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;

  for (let i = 0; i < 5; i += 1) {
    service.createTask({
      repoId,
      title: `Seed task ${i}`,
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
  }
});

afterAll(() => {
  dbClient.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("db.$client.backup", () => {
  it("produces a file that opens and reports the same task count as the source, with a writer active throughout", async () => {
    const initialCount = service.listTasks({ includeArchived: true }).length;
    expect(initialCount).toBe(5);

    const destination = path.join(tempDir, "backup-concurrent.db");

    // A second connection writing to the same file for the whole duration of
    // the backup — the scenario the online backup API exists for. Mutates
    // existing rows rather than inserting new ones, so the task count stays
    // a fixed, assertable value regardless of exactly how the writes and the
    // backup's page copies interleave.
    let writing = true;
    const writer = (async () => {
      const tasks = service.listTasks({ includeArchived: true });
      while (writing) {
        for (const task of tasks) {
          service.updateTask(task.id, { updatedAt: Date.now() });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await dbClient.db.$client.backup(destination);
    writing = false;
    await writer;

    expect(fs.existsSync(destination)).toBe(true);

    const backupHandle = new Database(destination, { readonly: true });
    try {
      const row = backupHandle.prepare("SELECT COUNT(*) as count FROM tasks").get() as {
        count: number;
      };
      expect(row.count).toBe(initialCount);
    } finally {
      backupHandle.close();
    }
  });
});
