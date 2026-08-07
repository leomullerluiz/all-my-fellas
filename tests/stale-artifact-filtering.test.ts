import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The §10.5 regression: with `VERIFICATION` ahead of `CODE_REVIEW`, a red
 * verification can send work back to the Developer before any reviewer ran
 * in that cycle. `gatherInputs` (execute.ts) is not exported — it composes
 * exactly these two primitives — so this exercises them directly against a
 * scenario matching the story's own description: a stale, already-approved
 * `code_review_report` from a previous cycle must not reach the next
 * Developer prompt as though it described the current code.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-artifact-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.WORKSPACES_DIR = path.join(tempDir, "workspaces");

type Service = typeof import("@/server/tasks/service");
let service: Service;

beforeAll(async () => {
  service = await import("@/server/tasks/service");
});

afterAll(async () => {
  const { closeDatabase } = await import("@/server/db/client");
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("stale reviewer artifacts across a VERIFICATION-triggered rework cycle", () => {
  it("excludes cycle 1's code_review_report once VERIFICATION sends cycle 2 back with no review", async () => {
    const repo = service.createRepo({
      name: "acme/stale-artifact",
      url: "https://github.com/acme/stale-artifact",
      defaultBranch: "main",
    });
    const task = service.createTask({
      repoId: repo.id,
      title: "Stale artifact regression",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    // Cycle 1: DEVELOPMENT #1 -> VERIFICATION #1 (passed) -> CODE_REVIEW #1
    // (approved, produces the artifact that must NOT survive into cycle 3).
    const dev1 = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.markStageRunStatus(dev1.id, "done");

    const verify1 = service.createStageRun({ taskId: task.id, stage: "VERIFICATION", attempt: 1 });
    service.markStageRunStatus(verify1.id, "done");

    const review1 = service.createStageRun({ taskId: task.id, stage: "CODE_REVIEW", attempt: 1 });
    service.markStageRunStatus(review1.id, "done");
    service.saveArtifact({
      taskId: task.id,
      stageRunId: review1.id,
      type: "code_review_report",
      contentMd: "## Verdict\n\nVerdict: approved\n\n## Summary\n\nLooks fine.\n",
    });

    // Cycle 2: DEVELOPMENT #2 finishes, but VERIFICATION #2 fails — no
    // CODE_REVIEW run happens in this cycle at all.
    const dev2 = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 2 });
    service.markStageRunStatus(dev2.id, "done");

    const verify2 = service.createStageRun({ taskId: task.id, stage: "VERIFICATION", attempt: 2 });
    service.markStageRunStatus(verify2.id, "done");

    // The naive lookup (pre-fix behaviour) would still find cycle 1's report —
    // proving the bug this fix closes is real, not hypothetical.
    const naive = service.latestArtifact(task.id, "code_review_report");
    expect(naive).not.toBeNull();

    // The fix: only artifacts produced after the previous DEVELOPMENT run
    // finished belong to "this" cycle.
    const previousDevelopmentRun = service.getStageRunByAttempt(task.id, "DEVELOPMENT", 2);
    expect(previousDevelopmentRun).not.toBeNull();
    const cycleStart = previousDevelopmentRun!.finishedAt ?? previousDevelopmentRun!.createdAt ?? 0;

    const filtered = service.latestArtifactSince(task.id, "code_review_report", cycleStart);
    expect(filtered).toBeNull();
  });

  it("still finds a fresh code_review_report produced after the previous DEVELOPMENT run finished", async () => {
    const repo = service.createRepo({
      name: "acme/fresh-artifact",
      url: "https://github.com/acme/fresh-artifact",
      defaultBranch: "main",
    });
    const task = service.createTask({
      repoId: repo.id,
      title: "Fresh artifact",
      description: "A description long enough to pass validation upstream.",
      priority: "medium",
    });

    const dev1 = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 1 });
    service.markStageRunStatus(dev1.id, "done");

    const dev2 = service.createStageRun({ taskId: task.id, stage: "DEVELOPMENT", attempt: 2 });
    service.markStageRunStatus(dev2.id, "done");

    const review = service.createStageRun({ taskId: task.id, stage: "CODE_REVIEW", attempt: 1 });
    service.markStageRunStatus(review.id, "done");
    service.saveArtifact({
      taskId: task.id,
      stageRunId: review.id,
      type: "code_review_report",
      contentMd: "## Verdict\n\nVerdict: changes_requested\n\n## Summary\n\nFix the loop.\n",
    });

    const previousDevelopmentRun = service.getStageRunByAttempt(task.id, "DEVELOPMENT", 2);
    const cycleStart = previousDevelopmentRun!.finishedAt ?? previousDevelopmentRun!.createdAt ?? 0;

    const filtered = service.latestArtifactSince(task.id, "code_review_report", cycleStart);
    expect(filtered).not.toBeNull();
    expect(filtered!.contentMd).toContain("Fix the loop");
  });
});
