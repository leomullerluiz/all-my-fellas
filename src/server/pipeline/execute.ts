import { roleFor } from "../agents/roles";
import type { RepoRow } from "../db/schema";
import { appendEvent } from "../events/store";
import { requireCredential, resolveCredential } from "../git/credentials";
import { createChangeRequest } from "../git/pull-request";
import { providerFor } from "../git/providers";
import {
  type RemoteAccess,
  branchNameFor,
  commitPendingChanges,
  diffAgainstBase,
  diffStatAgainstBase,
  hasCommitsAheadOfBase,
  prepareWorkspace,
  pushBranch,
  redactRemote,
  removeWorkspace,
} from "../git/workspace";
import { getSettings } from "../settings/store";
import {
  getStageRun,
  getTaskWithRepo,
  latestArtifact,
  markStageRunStatus,
  saveArtifact,
  saveTranscript,
  setTaskEstimate,
  updateStageRun,
  updateTask,
} from "../tasks/service";
import {
  extractPlanEstimate,
  extractReviewVerdict,
  validateArtifact,
} from "./artifacts";
import { advanceTask } from "./orchestrator";
import { type ArtifactInput, truncateForPrompt } from "./prompt";
import { runStage } from "./run-stage";
import { type AgentStage, ARTIFACT_FILENAMES, isAgentStage } from "./stages";
import type { ReviewVerdict } from "./state-machine";

/**
 * Stage execution as the worker performs it: prepare the workspace, run the
 * agent, validate and persist the artifact, then hand the outcome back to the
 * state machine.
 */

/** How much of a diff is handed to QA / homologation before truncation. */
const MAX_DIFF_CHARS = 60_000;
const MAX_DIFF_STAT_CHARS = 8_000;

export class StageJobError extends Error {
  constructor(
    message: string,
    /** When false the worker fails the task immediately instead of retrying. */
    readonly retryable = true,
  ) {
    super(message);
    this.name = "StageJobError";
  }
}

/**
 * Resolves a repository row into the credential and provider a git command
 * needs.
 *
 * @param required When true a missing credential throws instead of producing an
 *   unauthenticated command. Cloning a public repository works without one;
 *   pushing never does, and failing at the push after a full pipeline run is
 *   the expensive way to find out.
 */
function remoteAccessFor(repo: RepoRow, required = false): RemoteAccess {
  const provider = providerFor(repo.provider);
  const target = {
    provider,
    credentialRef: repo.credentialRef,
    credentialUsername: repo.credentialUsername,
  };
  return {
    provider,
    repoUrl: repo.url,
    credential: required ? requireCredential(target) : resolveCredential(target),
  };
}

/** Collects the artifacts a role consumes, newest version of each. */
function gatherInputs(taskId: string, stage: AgentStage, attempt: number): ArtifactInput[] {
  const role = roleFor(stage);
  const inputs: ArtifactInput[] = [];

  for (const type of role.consumes) {
    const artifact = latestArtifact(taskId, type);
    if (!artifact) {
      throw new StageJobError(
        `The ${role.name} stage requires ${ARTIFACT_FILENAMES[type]}, which was never produced.`,
        false,
      );
    }
    inputs.push({ type, content: artifact.contentMd });
  }

  // On a rework cycle the Developer additionally receives the reviewers'
  // reports — and only the reports, never their transcripts. Human feedback
  // comes last so it reads as the final word.
  if (stage === "DEVELOPMENT" && attempt > 1) {
    for (const type of ["code_review_report", "qa_report", "human_review"] as const) {
      const artifact = latestArtifact(taskId, type);
      if (artifact) inputs.push({ type, content: artifact.contentMd });
    }
  }

  return inputs;
}

/** Runs one agent stage end to end. */
export async function executeAgentStage(stageRunId: string): Promise<void> {
  const run = getStageRun(stageRunId);
  if (!run) throw new StageJobError(`Stage run ${stageRunId} not found.`, false);
  if (!isAgentStage(run.stage)) {
    throw new StageJobError(`${run.stage} is not an agent stage.`, false);
  }

  const task = getTaskWithRepo(run.taskId);
  if (!task) throw new StageJobError(`Task ${run.taskId} not found.`, false);

  const role = roleFor(run.stage);
  const settings = getSettings();
  const model = settings.models[run.stage];
  const maxTurns = run.maxTurns ?? settings.maxTurns[run.stage];
  const provider = settings.providers[run.stage];

  markStageRunStatus(stageRunId, "running");
  appendEvent(task.id, stageRunId, {
    type: "stage_started",
    stage: run.stage,
    attempt: run.attempt,
    model,
    provider,
  });

  // The workspace is created lazily on the first stage that needs it, and
  // reused by every later stage of the same task.
  let workspacePath: string | null = null;
  let branchName = task.branchName;

  if (role.needsWorkspace) {
    const workspace = await prepareWorkspace({
      taskId: task.id,
      title: task.title,
      defaultBranch: task.repo.defaultBranch,
      access: remoteAccessFor(task.repo),
      customBranchName: task.customBranchName,
    });
    workspacePath = workspace.path;
    branchName = workspace.branchName;

    if (task.workspacePath !== workspace.path || task.branchName !== workspace.branchName) {
      updateTask(task.id, {
        workspacePath: workspace.path,
        branchName: workspace.branchName,
      });
      appendEvent(task.id, stageRunId, {
        type: "git",
        message: `Workspace ready on branch ${workspace.branchName}.`,
      });
    }
  }

  const supplements: Array<{ label: string; body: string; fenced?: boolean }> = [];

  const wantsFullDiff = run.stage === "QA" || run.stage === "CODE_REVIEW";
  if (workspacePath && (wantsFullDiff || run.stage === "PO_HOMOLOGATION")) {
    const base = task.repo.defaultBranch;
    if (wantsFullDiff) {
      const diff = await diffAgainstBase(workspacePath, base);
      supplements.push({
        label: `Branch diff against origin/${base}`,
        body: truncateForPrompt(diff || "(no changes)", MAX_DIFF_CHARS),
        fenced: true,
      });
    } else {
      const stat = await diffStatAgainstBase(workspacePath, base);
      supplements.push({
        label: `Summary of changes against origin/${base}`,
        body: truncateForPrompt(stat || "(no changes)", MAX_DIFF_STAT_CHARS),
        fenced: true,
      });
    }
  }

  const inputs = gatherInputs(task.id, run.stage, run.attempt);

  let result;
  try {
    result = await runStage(provider, {
      role,
      model,
      maxTurns,
      workspacePath,
      prompt: {
        role,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          repoName: task.repo.name,
          branchName,
        },
        artifacts: inputs,
        supplements,
        attempt: run.attempt,
      },
      onEvent: (event) => appendEvent(task.id, stageRunId, event),
    });
  } catch (error) {
    const message = redactRemote(error instanceof Error ? error.message : String(error));
    markStageRunStatus(stageRunId, "failed", { error: message });
    throw new StageJobError(message);
  }

  saveTranscript({
    stageRunId,
    sessionId: result.sessionId,
    transcript: result.transcript,
  });
  // Record spend before validating, so a stage that produced a malformed
  // artifact still shows what it cost. `updateStageRun` rather than
  // `markStageRunStatus` — the latter would reset `startedAt` mid-run.
  updateStageRun(stageRunId, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });

  // Validation failure is not retryable at the job level: re-running the same
  // prompt is unlikely to produce a differently-shaped document, and silently
  // advancing with a malformed artifact would poison every later stage.
  let content: string;
  try {
    content = validateArtifact(role.produces, result.finalText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markStageRunStatus(stageRunId, "failed", { error: message });
    throw new StageJobError(message, false);
  }

  saveArtifact({
    taskId: task.id,
    stageRunId,
    type: role.produces,
    contentMd: content,
  });
  appendEvent(task.id, stageRunId, {
    type: "artifact_saved",
    artifactType: role.produces,
  });

  let reviewVerdict: ReviewVerdict | undefined;

  if (run.stage === "ARCHITECTURE") {
    const estimate = extractPlanEstimate(content);
    setTaskEstimate(task.id, estimate.difficulty, estimate.criticality);
    appendEvent(task.id, stageRunId, {
      type: "log",
      level: "info",
      message: `Estimate — difficulty: ${estimate.difficulty ?? "unknown"}, criticality: ${
        estimate.criticality ?? "unknown"
      }.`,
    });
  }

  if (run.stage === "DEVELOPMENT" && workspacePath) {
    const committed = await commitPendingChanges(
      workspacePath,
      `chore(pipeline): commit remaining changes for ${task.id}`,
    );
    if (committed) {
      appendEvent(task.id, stageRunId, {
        type: "git",
        message: "Committed changes the developer left in the working tree.",
      });
    }
    if (!(await hasCommitsAheadOfBase(workspacePath, task.repo.defaultBranch))) {
      const message = "The developer stage produced no commits on the task branch.";
      markStageRunStatus(stageRunId, "failed", { error: message });
      throw new StageJobError(message, false);
    }
  }

  if (run.stage === "QA" || run.stage === "CODE_REVIEW") {
    reviewVerdict = extractReviewVerdict(content);
    appendEvent(task.id, stageRunId, {
      type: "log",
      level: reviewVerdict === "approved" ? "info" : "warn",
      message: `${role.name} verdict: ${reviewVerdict}.`,
    });
  }

  markStageRunStatus(stageRunId, "done");
  appendEvent(task.id, stageRunId, {
    type: "stage_finished",
    stage: run.stage,
    attempt: run.attempt,
    costUsd: result.costUsd,
  });

  advanceTask(task.id, { kind: "stage_succeeded", stage: run.stage, reviewVerdict });
}

/** Builds the pull request body from the stories and the developer report. */
function buildPullRequestBody(taskId: string, taskTitle: string): string {
  const stories = latestArtifact(taskId, "stories")?.contentMd ?? "";
  const devReport = latestArtifact(taskId, "dev_report")?.contentMd ?? "";
  const qaReport = latestArtifact(taskId, "qa_report")?.contentMd ?? "";

  return [
    `## ${taskTitle}`,
    "",
    `Delivered by the multi-agent pipeline (task \`${taskId}\`).`,
    "",
    "<details><summary>User stories</summary>",
    "",
    stories || "_Not available._",
    "",
    "</details>",
    "",
    "<details><summary>Developer report</summary>",
    "",
    devReport || "_Not available._",
    "",
    "</details>",
    "",
    "<details><summary>QA report</summary>",
    "",
    qaReport || "_Not available._",
    "",
    "</details>",
  ].join("\n");
}

/** Pushes the task branch and opens the pull request. */
export async function executeDelivery(stageRunId: string): Promise<void> {
  const run = getStageRun(stageRunId);
  if (!run) throw new StageJobError(`Stage run ${stageRunId} not found.`, false);

  const task = getTaskWithRepo(run.taskId);
  if (!task) throw new StageJobError(`Task ${run.taskId} not found.`, false);
  if (!task.workspacePath || !task.branchName) {
    throw new StageJobError("The task has no workspace to deliver from.", false);
  }

  markStageRunStatus(stageRunId, "running");
  appendEvent(task.id, stageRunId, {
    type: "stage_started",
    stage: "DELIVERY",
    attempt: run.attempt,
  });

  try {
    await pushBranch(task.workspacePath, task.branchName, remoteAccessFor(task.repo, true));
    appendEvent(task.id, stageRunId, {
      type: "git",
      message: `Pushed ${task.branchName} to origin.`,
    });

    const change = await createChangeRequest({
      connection: task.repo,
      headBranch: task.branchName,
      title: task.title,
      body: buildPullRequestBody(task.id, task.title),
    });

    updateTask(task.id, { prUrl: change.url });

    if (change.status === "created") {
      appendEvent(task.id, stageRunId, { type: "pr_opened", url: change.url });
    } else {
      appendEvent(task.id, stageRunId, {
        type: "log",
        level: "warn",
        message:
          `Branch pushed, but the ${change.noun} was not opened automatically ` +
          `(${change.reason}). Open it here: ${change.url}`,
      });
    }
  } catch (error) {
    const message = redactRemote(error instanceof Error ? error.message : String(error));
    markStageRunStatus(stageRunId, "failed", { error: message });
    throw new StageJobError(message);
  }

  markStageRunStatus(stageRunId, "done");
  appendEvent(task.id, stageRunId, {
    type: "stage_finished",
    stage: "DELIVERY",
    attempt: run.attempt,
    costUsd: 0,
  });

  advanceTask(task.id, { kind: "stage_succeeded", stage: "DELIVERY" });
}

/** Deletes a finished task's workspace once its retention window has elapsed. */
export async function executeCleanup(taskId: string): Promise<void> {
  await removeWorkspace(taskId);
  updateTask(taskId, { workspacePath: null });
  appendEvent(taskId, null, {
    type: "log",
    level: "info",
    message: "Workspace removed.",
  });
}

/** Recomputes the branch name for a task, used by the UI before delivery. */
export function previewBranchName(taskId: string, title: string): string {
  return branchNameFor(taskId, title);
}
