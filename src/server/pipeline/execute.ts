import { roleFor } from "../agents/roles";
import type { RepoRow } from "../db/schema";
import { appendEvent } from "../events/store";
import { requireCredential, resolveCredential } from "../git/credentials";
import { readDiffIndex } from "../git/diff";
import { createChangeRequest } from "../git/pull-request";
import { providerFor } from "../git/providers";
import {
  type RemoteAccess,
  branchNameFor,
  commitPendingChanges,
  diffAgainstBase,
  diffStatAgainstBase,
  hasCommitsAheadOfBase,
  headCommitSha,
  prepareWorkspace,
  pushBranch,
  redactRemote,
  removeWorkspace,
} from "../git/workspace";
import { getSettings } from "../settings/store";
import {
  getStageRun,
  getStageRunByAttempt,
  getTaskWithRepo,
  latestArtifact,
  latestArtifactSince,
  listStageRuns,
  listVerificationRuns,
  markStageRunStatus,
  saveArtifact,
  saveTranscript,
  saveVerificationRuns,
  setTaskEstimate,
  updateStageRun,
  updateTask,
} from "../tasks/service";
import {
  extractHomologationVerdict,
  extractPlanEstimate,
  extractReviewVerdict,
  validateArtifact,
} from "./artifacts";
import { redactSecrets } from "./audit/redact";
import { renderDiffSummaryArtifact } from "./diff-summary";
import { advanceTask } from "./orchestrator";
import {
  type ArtifactInput,
  type StagePromptInput,
  MAX_PROMPT_CHARS,
  buildStagePrompt,
  buildSystemPrompt,
  truncateForPrompt,
} from "./prompt";
import { StageExecutionError, runStage } from "./run-stage";
import { type AgentStage, ARTIFACT_FILENAMES, type FailureKind, isAgentStage } from "./stages";
import type { HomologationVerdict, ReviewVerdict } from "./state-machine";
import { type CommandResult, type VerificationOutcome, runVerification } from "./verification";

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
    /**
     * Why the stage failed, forwarded to the `stage_failed` signal so the
     * task's terminal `failure_kind` reflects it. `"stage_error"` is right for
     * every throw site but the three that declare a more specific kind below.
     */
    readonly kind: FailureKind = "stage_error",
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
  // comes last so it reads as the final word. `verification_report` goes
  // first: a compile error outranks an opinion.
  if (stage === "DEVELOPMENT" && attempt > 1) {
    const verification = latestArtifact(taskId, "verification_report");
    if (verification) inputs.push({ type: "verification_report", content: verification.contentMd });

    // With `VERIFICATION` ahead of `CODE_REVIEW`, a red verification can send
    // work back to the Developer before any reviewer ran in this cycle, so
    // `latestArtifact` alone could still hand over a stale, already-approved
    // report from an earlier cycle (spec §10.5). Only reports produced after
    // the previous DEVELOPMENT run finished belong to the cycle that just
    // ended.
    const previousDevelopmentRun = getStageRunByAttempt(taskId, "DEVELOPMENT", attempt - 1);
    const cycleStart = previousDevelopmentRun?.finishedAt ?? previousDevelopmentRun?.createdAt ?? 0;
    for (const type of ["code_review_report", "qa_report", "homolog_report", "human_review"] as const) {
      const artifact = latestArtifactSince(taskId, type, cycleStart);
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

  // The pipeline's own mechanical result, not the agent's claim about it —
  // see spec-mechanical-verification.md §8.1. Not fenced: it is structured
  // Markdown produced by the worker, unlike a raw diff.
  if (run.stage === "QA" || run.stage === "PO_HOMOLOGATION") {
    const report = latestArtifact(task.id, "verification_report");
    supplements.push({
      label: "Mechanical verification (run by the pipeline, not by you)",
      body: report?.contentMd ?? "No verification has been run for this task.",
    });
  }

  const inputs = gatherInputs(task.id, run.stage, run.attempt);

  const promptInput: StagePromptInput = {
    role,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      repoName: task.repo.name,
      repoContext: task.repo.context,
      branchName,
    },
    artifacts: inputs,
    supplements,
    attempt: run.attempt,
  };

  // Persisted before the provider is invoked, not after: the case where the
  // prompt matters most — a stage that fails — is the case where it would
  // otherwise never reach `stage_runs` at all. See spec-audit-trail.md §4.
  // The builders run again inside the provider (`runStage`); that duplication
  // is pure string assembly over a cached file and costs nothing measurable.
  updateStageRun(stageRunId, {
    systemPrompt: redactSecrets(buildSystemPrompt(role)).text,
    userPrompt: redactSecrets(truncateForPrompt(buildStagePrompt(promptInput), MAX_PROMPT_CHARS)).text,
    model,
    provider,
  });

  let result;
  try {
    result = await runStage(provider, {
      role,
      model,
      maxTurns,
      workspacePath,
      prompt: promptInput,
      onEvent: (event) => appendEvent(task.id, stageRunId, event),
    });
  } catch (error) {
    const message = redactRemote(error instanceof Error ? error.message : String(error));

    // Every provider builds a partial result for exactly this case
    // (`StageExecutionError.partial`) — the transcript of a failed run is the
    // one most worth having, and today it is thrown away. See §12.2.
    if (error instanceof StageExecutionError && error.partial.transcript) {
      saveTranscript({
        stageRunId,
        sessionId: error.partial.sessionId ?? null,
        transcript: error.partial.transcript,
      });
      updateStageRun(stageRunId, {
        inputTokens: error.partial.inputTokens ?? 0,
        outputTokens: error.partial.outputTokens ?? 0,
        costUsd: error.partial.costUsd ?? 0,
      });
    }

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
    throw new StageJobError(message, false, "artifact_invalid");
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
  let homologationVerdict: HomologationVerdict | undefined;

  if (run.stage === "ARCHITECTURE") {
    const estimate = extractPlanEstimate(content);
    setTaskEstimate(task.id, estimate.difficulty, estimate.criticality);
    appendEvent(task.id, stageRunId, {
      type: "log",
      level: "info",
      message: `Estimate — difficulty: ${estimate.difficulty ?? "unknown"}, criticality: ${estimate.criticality ?? "unknown"
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
      throw new StageJobError(message, false, "no_commits");
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

  if (run.stage === "PO_HOMOLOGATION") {
    homologationVerdict = extractHomologationVerdict(content);
    appendEvent(task.id, stageRunId, {
      type: "log",
      level: homologationVerdict === "accepted" ? "info" : "warn",
      message: `${role.name} verdict: ${homologationVerdict}.`,
    });
  }

  markStageRunStatus(stageRunId, "done");
  appendEvent(task.id, stageRunId, {
    type: "stage_finished",
    stage: run.stage,
    attempt: run.attempt,
    costUsd: result.costUsd,
  });

  advanceTask(task.id, {
    kind: "stage_succeeded",
    stage: run.stage,
    reviewVerdict,
    homologationVerdict,
  });
}

function resultLine(result: CommandResult): string {
  const outcome = result.timedOut
    ? "⏱ timed out"
    : result.exitCode === null
      ? "⚠ could not start"
      : result.exitCode === 0
        ? "✅ exit 0"
        : `❌ exit ${result.exitCode}`;
  return `| \`${result.command}\` | ${result.kind} | ${outcome} | ${Math.round(result.durationMs / 1000)}s |`;
}

/**
 * Renders `verification_report` from the persisted rows. Not passed through
 * `validateArtifact` — the document is machine-generated, and validating it
 * would just be the worker checking its own template, the same shortcut
 * `human_review` already takes (`decideGate`).
 */
function renderVerificationReport(outcome: VerificationOutcome): string {
  const results = outcome.status === "skipped" ? [] : outcome.results;

  const summary =
    outcome.status === "skipped"
      ? "Skipped — no verification commands are configured for this repository."
      : outcome.status === "errored"
        ? `Errored: ${outcome.reason}`
        : outcome.status === "failed"
          ? `Failed: ${outcome.failed.map((result) => `\`${result.command}\` exited ${result.exitCode}`).join(", ")}`
          : "Passed.";

  const commandsTable =
    results.length === 0
      ? "None."
      : ["| Command | Kind | Result | Duration |", "|---|---|---|---|", ...results.map(resultLine)].join("\n");

  const output =
    results.length === 0
      ? "None."
      : results
        .map((result) => {
          const parts = [`### ${result.kind}: \`${result.command}\``, "", "```", result.stdoutTail || "(no stdout)", "```"];
          if (result.stderrTail) parts.push("```", result.stderrTail, "```");
          return parts.join("\n");
        })
        .join("\n\n");

  return ["## Outcome", "", summary, "", "## Commands", "", commandsTable, "", "## Output", "", output].join("\n");
}

/**
 * Runs a repository's configured install/build/test/lint commands against
 * the task's workspace, persists the result, and routes the task on the real
 * exit codes — mechanical, not an agent's claim about itself.
 *
 * `skipped` and `passed` both map to `reviewVerdict: "approved"` (the shape
 * `CODE_REVIEW` and `QA` already share, per `state-machine.ts`'s rule against
 * a second near-identical field). `errored` never reaches the state machine
 * as a success signal at all: it throws a retryable `StageJobError` instead,
 * entering the worker's ordinary backoff — an environment failure, not a
 * rework signal (spec §6.3).
 */
export async function executeVerification(stageRunId: string): Promise<void> {
  const run = getStageRun(stageRunId);
  if (!run) throw new StageJobError(`Stage run ${stageRunId} not found.`, false);
  if (run.stage !== "VERIFICATION") {
    throw new StageJobError(`${run.stage} is not the verification stage.`, false);
  }

  const task = getTaskWithRepo(run.taskId);
  if (!task) throw new StageJobError(`Task ${run.taskId} not found.`, false);
  if (!task.workspacePath) {
    throw new StageJobError("The task has no workspace to verify.", false);
  }

  markStageRunStatus(stageRunId, "running");
  appendEvent(task.id, stageRunId, {
    type: "stage_started",
    stage: "VERIFICATION",
    attempt: run.attempt,
  });

  const outcome = await runVerification(task.repo, task.workspacePath, (event) =>
    appendEvent(task.id, stageRunId, event),
  );

  saveVerificationRuns(task.id, stageRunId, outcome.status === "skipped" ? [] : outcome.results);

  const report = renderVerificationReport(outcome);
  saveArtifact({
    taskId: task.id,
    stageRunId,
    type: "verification_report",
    contentMd: report,
  });
  appendEvent(task.id, stageRunId, { type: "artifact_saved", artifactType: "verification_report" });

  appendEvent(task.id, stageRunId, {
    type: "verification_finished",
    status: outcome.status,
    reason: outcome.status === "errored" ? outcome.reason : undefined,
  });

  if (outcome.status === "errored") {
    const message = `Verification could not run: ${outcome.reason}`;
    markStageRunStatus(stageRunId, "failed", { error: message });
    throw new StageJobError(message, true);
  }

  markStageRunStatus(stageRunId, "done");
  appendEvent(task.id, stageRunId, {
    type: "stage_finished",
    stage: "VERIFICATION",
    attempt: run.attempt,
    costUsd: 0,
  });

  const reviewVerdict: ReviewVerdict =
    outcome.status === "passed" || outcome.status === "skipped" ? "approved" : "changes_requested";

  // Named, not generic: if the rework budget is spent on this failure, the
  // terminal message should say which command broke rather than just that
  // "verification failed" (spec §9.1's worked example).
  const detail =
    outcome.status === "failed"
      ? `Verification failed (${outcome.failed
        .map((result) => `\`${result.command}\` exited ${result.exitCode}`)
        .join(", ")})`
      : undefined;

  advanceTask(task.id, { kind: "stage_succeeded", stage: "VERIFICATION", reviewVerdict, detail });
}

function pullRequestResultCell(run: { exitCode: number | null; timedOut: boolean }): string {
  if (run.timedOut) return "⏱ timed out";
  if (run.exitCode === null) return "⚠ could not start";
  return run.exitCode === 0 ? "✅ exit 0" : `❌ exit ${run.exitCode}`;
}

/**
 * Renders the `## Verification` section from the latest `VERIFICATION`
 * stage run's rows. Expanded rather than inside a `<details>`: it is the
 * part a reviewer on the provider's side should not have to click for.
 */
function verificationSection(taskId: string): string {
  const latestRun = listStageRuns(taskId).filter((run) => run.stage === "VERIFICATION").at(-1);
  const rows = latestRun ? listVerificationRuns(taskId, latestRun.id) : [];

  if (rows.length === 0) {
    return (
      "No verification commands are configured for this repository, so " +
      "**nothing was run mechanically**. The reports below are the agents' own assessments."
    );
  }

  return [
    "| Command | Result | Duration |",
    "|---|---|---|",
    ...rows.map(
      (row) => `| \`${row.command}\` | ${pullRequestResultCell(row)} | ${Math.round(row.durationMs / 1000)}s |`,
    ),
  ].join("\n");
}

/**
 * Builds the pull request body from the stories and the developer report.
 *
 * Exported for `tests/execute-pr-body.test.ts` — the only other caller,
 * `executeDelivery`, needs a real git push and provider API call to reach it.
 */
export function buildPullRequestBody(taskId: string, taskTitle: string): string {
  const stories = latestArtifact(taskId, "stories")?.contentMd ?? "";
  const devReport = latestArtifact(taskId, "dev_report")?.contentMd ?? "";
  const qaReport = latestArtifact(taskId, "qa_report")?.contentMd ?? "";

  return [
    `## ${taskTitle}`,
    "",
    `Delivered by the multi-agent pipeline (task \`${taskId}\`).`,
    "",
    "## Verification",
    "",
    verificationSection(taskId),
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

  // Written before the push, in its own try/catch: the workspace is
  // guaranteed present here (the guard above already failed the stage
  // outright without it), and a delivery that fails at the push or at PR
  // creation still leaves a record of what was about to ship. Losing this
  // record is bad; refusing to open a pull request over it is worse — see
  // spec-audit-trail.md §8.
  try {
    const base = task.repo.defaultBranch;
    const [index, sha] = await Promise.all([
      readDiffIndex(task.workspacePath, base),
      headCommitSha(task.workspacePath),
    ]);
    const body = validateArtifact(
      "diff_summary",
      renderDiffSummaryArtifact({
        baseBranch: base,
        headBranch: task.branchName,
        headCommitSha: sha,
        index,
      }),
    );
    saveArtifact({ taskId: task.id, stageRunId, type: "diff_summary", contentMd: body });
    appendEvent(task.id, stageRunId, { type: "artifact_saved", artifactType: "diff_summary" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEvent(task.id, stageRunId, {
      type: "log",
      level: "warn",
      message: `Could not persist the diff summary before delivery: ${message}`,
    });
  }

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
    throw new StageJobError(message, true, "delivery_failed");
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
