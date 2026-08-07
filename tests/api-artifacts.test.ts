import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Artifact version history (S4 / spec-audit-trail.md §7):
 * `listArtifacts`, `listArtifactVersions`, and the single-artifact route the
 * version switcher fetches an older body from.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-artifacts-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

let service: typeof import("@/server/tasks/service");
let artifactRoute: typeof import("@/app/api/tasks/[id]/artifacts/[artifactId]/route");
let repoId: string;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
  artifactRoute = await import("@/app/api/tasks/[id]/artifacts/[artifactId]/route");

  repoId = service.createRepo({
    name: "acme/api-artifacts",
    url: "https://github.com/acme/api-artifacts",
    defaultBranch: "main",
  }).id;
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function newTaskWithReworkedDevReport() {
  const task = service.createTask({
    repoId,
    title: "Artifact versions task",
    description: "A description long enough to pass validation upstream.",
    priority: "medium",
  });

  const ids: string[] = [];
  for (const attempt of [1, 2, 3]) {
    const run = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt });
    const artifact = service.saveArtifact({
      taskId: task.id,
      stageRunId: run.id,
      type: "dev_report",
      contentMd: `# Report attempt ${attempt}`,
    });
    ids.push(artifact.id);
  }

  return { task, ids };
}

describe("listArtifacts", () => {
  it("returns every version of one type, newest first, with full bodies", () => {
    const { task, ids } = newTaskWithReworkedDevReport();

    const versions = service.listArtifacts(task.id, "dev_report");
    expect(versions.map((v) => v.id)).toEqual([...ids].reverse());
    expect(versions[0].contentMd).toBe("# Report attempt 3");
  });
});

describe("listArtifactVersions", () => {
  it("returns metadata for every artifact without loading any content_md", () => {
    const { task } = newTaskWithReworkedDevReport();

    const versions = service.listArtifactVersions(task.id);
    const devReportVersions = versions.filter((v) => v.type === "dev_report");
    expect(devReportVersions).toHaveLength(3);
    expect(new Set(devReportVersions.map((v) => v.attempt))).toEqual(new Set([1, 2, 3]));
    for (const version of devReportVersions) {
      expect("contentMd" in version).toBe(false);
      expect(version.sizeBytes).toBeGreaterThan(0);
    }
  });
});

describe("GET /api/tasks/:id/artifacts/:artifactId", () => {
  it("returns one artifact's full body", async () => {
    const { task, ids } = newTaskWithReworkedDevReport();

    const response = await artifactRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: task.id, artifactId: ids[0] }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.contentMd).toBe("# Report attempt 1");
    expect(body.type).toBe("dev_report");
  });

  it("returns 404 for an artifactId belonging to another task", async () => {
    const { ids: foreignIds } = newTaskWithReworkedDevReport();
    const { task: otherTask } = newTaskWithReworkedDevReport();

    const response = await artifactRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: otherTask.id, artifactId: foreignIds[0] }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown artifactId", async () => {
    const { task } = newTaskWithReworkedDevReport();

    const response = await artifactRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: task.id, artifactId: "art_nonexistent" }),
    });

    expect(response.status).toBe(404);
  });
});
