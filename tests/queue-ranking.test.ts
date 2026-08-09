import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `src/server/pipeline/task-ranking.ts` — the single priority/difficulty
 * ranking shared by `claimNextJob` (SQL), the orchestrator's batch/promotion
 * paths (JS), and the board's On Queue column (JS). This is the direct unit
 * test the shared module's extraction is for: a fixture spanning every
 * priority × difficulty combination, including `difficulty = NULL`,
 * asserting the JS comparator and the SQL fragment agree — see
 * `techplan.md`'s risk note calling this load-bearing, not optional, because
 * a wrong tiebreak here silently starves a task rather than erroring.
 *
 * `difficulty = NULL` and `difficulty = 'M'` rank equally by design (both
 * fall to the `ELSE` branch of `DIFFICULTY_RANK`/`difficultyRankJs`), so a
 * fixture covering both is a genuine tie, not an oversight — an explicit
 * `title` tiebreak (applied identically to both the JS pre-sort and the SQL
 * `ORDER BY`) is what keeps this a single well-defined expected order rather
 * than one that only coincidentally matches.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-ranking-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let ranking: typeof import("@/server/pipeline/task-ranking");
let db: typeof import("@/server/db/client").db;
let schema: typeof import("@/server/db/schema");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  ranking = await import("@/server/pipeline/task-ranking");
  ({ db } = await import("@/server/db/client"));
  schema = await import("@/server/db/schema");

  repoId = service.createRepo({
    name: "acme/app",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const task of service.listTasks()) service.deleteTask(task.id);
});

type Priority = "low" | "medium" | "high" | "urgent";
const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
const DIFFICULTIES: Array<"S" | "M" | "L" | null> = ["S", "M", "L", null];

const PRIORITY_RANK_JS: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
function difficultyRankJs(difficulty: "S" | "M" | "L" | null): number {
  return difficulty === "S" ? 0 : difficulty === "L" ? 2 : 1;
}
/** Byte-order comparison, matching SQLite's default `BINARY` collation for ASCII text. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

describe("task-ranking: JS comparator agrees with the SQL fragment", () => {
  it("orders every priority × difficulty combination (16, including NULL) identically", () => {
    const fixture: Array<{ title: string; priority: Priority; difficulty: "S" | "M" | "L" | null }> = [];
    for (const priority of PRIORITIES) {
      for (const difficulty of DIFFICULTIES) {
        fixture.push({ title: `${priority}-${difficulty ?? "null"}`, priority, difficulty });
      }
    }

    const expectedOrder = [...fixture]
      .sort((a, b) => {
        const priorityDelta = PRIORITY_RANK_JS[a.priority] - PRIORITY_RANK_JS[b.priority];
        if (priorityDelta !== 0) return priorityDelta;
        const difficultyDelta = difficultyRankJs(a.difficulty) - difficultyRankJs(b.difficulty);
        if (difficultyDelta !== 0) return difficultyDelta;
        return byteCompare(a.title, b.title);
      })
      .map((entry) => entry.title);

    // Insert in a scrambled order so neither ranking could pass by accident
    // via creation/insertion order.
    const scrambled = [...fixture].reverse();
    const created = scrambled.map((entry) => {
      const task = service.createTask({
        repoId,
        title: entry.title,
        description: "A description long enough to pass validation upstream.",
        priority: entry.priority,
      });
      if (entry.difficulty) service.setTaskEstimate(task.id, entry.difficulty, null);
      // `setTaskEstimate` writes through the DB, not the `task` object
      // returned above — re-read so the in-memory row actually carries the
      // difficulty the JS comparator is being tested against.
      return service.getTask(task.id)!;
    });

    // JS comparator: pre-sort by title (the explicit tiebreak), then apply
    // the shared rank comparator — stable, so the title order survives
    // within a priority/difficulty tie.
    const titleSorted = [...created].sort((a, b) => byteCompare(a.title, b.title));
    const jsOrder = ranking.sortByPriorityThenDifficulty(titleSorted).map((task) => task.title);

    // SQL fragment, with the same explicit tiebreak in the `ORDER BY`.
    const sqlOrder = db
      .select({ title: schema.tasks.title })
      .from(schema.tasks)
      .orderBy(ranking.PRIORITY_RANK, ranking.DIFFICULTY_RANK, schema.tasks.title)
      .all()
      .map((row) => row.title);

    expect(jsOrder).toEqual(expectedOrder);
    expect(sqlOrder).toEqual(expectedOrder);
  });
});
