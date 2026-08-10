import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { csvField, stageRunsToCsv, toCsvRow } from "@/server/usage/csv";
import type { StageRunExportRow } from "@/server/tasks/service";

/**
 * stories.md S5 — one CSV row per `stage_runs` row (including `failed`/
 * `cancelled`), RFC 4180 quoting, and window/task-id filter parity with the
 * Costs page's `costPerTask(days)`.
 */

describe("csvField", () => {
  it("passes a plain field through unquoted", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(42)).toBe("42");
  });

  it("renders null/undefined as an empty field", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes a field containing a comma and doubles internal quotes", () => {
    expect(csvField('Fix the "login" bug, finally')).toBe('"Fix the ""login"" bug, finally"');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });
});

describe("toCsvRow", () => {
  it("joins escaped fields with commas", () => {
    expect(toCsvRow(["a", 1, null, 'b,"c"'])).toBe('a,1,,"b,""c"""');
  });
});

describe("stageRunsToCsv", () => {
  const baseRow: StageRunExportRow = {
    taskId: "task_1",
    taskTitle: "Plain title",
    repo: "acme/app",
    stage: "DEVELOPMENT",
    attempt: 1,
    provider: "claude",
    model: "claude-sonnet-5",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_100_000,
    inputTokens: 1000,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
    outputTokens: 200,
    costUsd: 0.42,
    status: "done",
  };

  it("has a one-line header naming every documented column", () => {
    const csv = stageRunsToCsv([]);
    const [header] = csv.split("\r\n");
    expect(header).toBe(
      "task_id,task_title,repo,stage,attempt,provider,model,started_at,finished_at," +
        "input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,status",
    );
  });

  it("includes rows with status failed and cancelled, not just done", () => {
    const rows: StageRunExportRow[] = [
      { ...baseRow, status: "failed" },
      { ...baseRow, status: "cancelled" },
      { ...baseRow, status: "done" },
    ];
    const csv = stageRunsToCsv(rows);
    const lines = csv.trim().split("\r\n");
    expect(lines.length).toBe(4); // header + 3 rows
    expect(csv).toContain(",failed");
    expect(csv).toContain(",cancelled");
  });

  it("round-trips a task title containing a comma and a double quote", () => {
    const row: StageRunExportRow = { ...baseRow, taskTitle: 'Fix "login", finally' };
    const csv = stageRunsToCsv([row]);
    const [, dataLine] = csv.trim().split("\r\n");
    expect(dataLine).toContain('"Fix ""login"", finally"');
  });
});

// Filter parity between the export and `costPerTask` is exercised against a
// real database, since it depends on the same `tasks.createdAt` cutoff.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-csv-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
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

describe("stageRunExport — window filter parity with costPerTask (S5)", () => {
  it("produces the same task set as costPerTask(days) for the same window", () => {
    const old = service.createTask({
      repoId,
      title: "Old task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    service.updateTask(old.id, { createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    service.createStageRun({ taskId: old.id, stage: "DEVELOPMENT", attempt: 1 });

    const recent = service.createTask({
      repoId,
      title: "Recent task",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    service.createStageRun({ taskId: recent.id, stage: "DEVELOPMENT", attempt: 1 });

    const exportedTaskIds = new Set(service.stageRunExport({ days: 7 }).map((row) => row.taskId));
    const pageTaskIds = new Set(service.costPerTask(7).map((row) => row.taskId));

    expect(exportedTaskIds).toEqual(new Set([recent.id]));
    expect(exportedTaskIds).toEqual(pageTaskIds);
  });

  it("scopes to one task when taskId is given", () => {
    const a = service.createTask({
      repoId,
      title: "A",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    const b = service.createTask({
      repoId,
      title: "B",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });
    service.createStageRun({ taskId: a.id, stage: "DEVELOPMENT", attempt: 1 });
    service.createStageRun({ taskId: b.id, stage: "DEVELOPMENT", attempt: 1 });

    const rows = service.stageRunExport({ taskId: a.id });
    expect(rows.map((row) => row.taskId)).toEqual([a.id]);
  });
});
