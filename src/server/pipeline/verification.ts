import { type ChildProcess, spawn, spawnSync } from "node:child_process";

import { resolveWorkspacesDir } from "../config/env";
import type { RepoRow } from "../db/schema";
import type { PipelineEvent, VerificationKind } from "../events/store";
import { redactRemote } from "../git/workspace";
import { isInsideWorkspace } from "./guardrails";

/**
 * The mechanical verification runner.
 *
 * Arbitrary programs, executed on the host that runs the worker, entirely
 * outside the `canUseTool` guard — see spec §11.1. That is acceptable because
 * the commands come from the operator (`repos.verify_*`), through the same
 * dashboard that already configures a git credential's environment variable
 * name, and never from a model. No shell, no agent tool call, no secret in
 * the child's environment.
 */

export type CommandResult = {
  kind: VerificationKind;
  /** As configured, for the audit trail. */
  command: string;
  /** `null` when killed by the timeout, or when the process could not be spawned. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
};

export type VerificationOutcome =
  | { status: "passed"; results: CommandResult[] }
  | { status: "failed"; results: CommandResult[]; failed: CommandResult[] }
  | { status: "skipped"; reason: "no_commands_configured" }
  /** Environment, not code — never a success signal to the state machine. */
  | { status: "errored"; reason: string; results: CommandResult[] };

const DEFAULT_TIMEOUT_SECONDS = 600;

/** Read from the child per stream, ring-buffered — the largest of the caps. */
const MAX_CAPTURED_CHARS = 256 * 1024;
/** Persisted to `verification_runs` per stream. Always the *tail*. */
const PERSIST_TAIL_CHARS = 8 * 1024;
/** Streamed to the live log per command per stream before it goes quiet. */
const STREAM_CAP_CHARS = 64 * 1024;
/** Flush the streamed buffer at least this often… */
const FLUSH_INTERVAL_MS = 500;
/** …or once it holds this much, whichever comes first. */
const FLUSH_CHARS = 4 * 1024;
/** Grace period between SIGTERM and SIGKILL on POSIX. */
const KILL_GRACE_MS = 5_000;

/**
 * Environment allowlist. Everything else — every LLM API key, `GITHUB_TOKEN`,
 * every credential a connection names — is dropped rather than filtered by
 * name, so a child process (which can make network calls, unlike an agent's
 * guarded tools) never sees a secret the pipeline holds.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "SystemRoot",
] as const;

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = { CI: "true" };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Splits a stored command string into argv.
 *
 * No shell interpretation of any kind — `createRepoSchema`'s command field
 * already rejects `; & | \` $ < > ( ) { } \n \r \\` at save time, so this only
 * has to understand whitespace and simple quoting, not redirection or
 * substitution.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") args.push(current);
  return args;
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function appendCapped(buffer: string, chunk: string, maxChars: number): string {
  const combined = buffer + chunk;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

/**
 * Kills the whole process tree, not just the direct child.
 *
 * `npm`, `pnpm`, `poetry` and friends do the real work in a grandchild; killing
 * only the parent orphans it and the timeout accomplishes nothing. POSIX gets a
 * real process group (`detached: true` at spawn time) and real signals;
 * Windows has neither, so `taskkill /t /f` walks the tree itself.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS);
}

type RunCommandOptions = {
  kind: VerificationKind;
  command: string;
  cwd: string;
  timeoutMs: number;
  emit: (event: PipelineEvent) => void;
};

/** Runs one command to completion (or timeout) and reports the result. */
function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const { kind, command, cwd, timeoutMs, emit } = options;
  const [file, ...args] = splitCommand(command);
  const startedAt = Date.now();

  emit({ type: "verification_command_started", kind, command });

  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv() as NodeJS.ProcessEnv,
        // A real process group on POSIX, so `killProcessTree` can signal the
        // whole tree instead of just this one process.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      // A command absent from PATH (or otherwise unspawnable) is `errored`,
      // never a silent zero-exit or an empty result — see spec §10.4.
      const message = redactRemote(error instanceof Error ? error.message : String(error));
      resolve({
        kind,
        command,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdoutTail: "",
        stderrTail: tail(message, PERSIST_TAIL_CHARS),
      });
      return;
    }

    let stdoutCaptured = "";
    let stderrCaptured = "";
    let stdoutPending = "";
    let stderrPending = "";
    let stdoutStreamedChars = 0;
    let stderrStreamedChars = 0;
    let stdoutStreamCapped = false;
    let stderrStreamCapped = false;
    let timedOut = false;
    let settled = false;

    function flush(stream: "stdout" | "stderr"): void {
      const pending = stream === "stdout" ? stdoutPending : stderrPending;
      if (pending === "") return;
      if (stream === "stdout") stdoutPending = "";
      else stderrPending = "";
      emit({ type: "verification_output", kind, stream, chunk: pending });
    }

    const flushTimer = setInterval(() => {
      flush("stdout");
      flush("stderr");
    }, FLUSH_INTERVAL_MS);

    function onData(stream: "stdout" | "stderr", data: Buffer): void {
      // Redacted before it is captured or streamed at all — see spec §11.3.
      // Install/build output can legitimately echo a credential-bearing remote
      // URL (a private git dependency failing to resolve, for instance), and
      // this text reaches the database, the live SSE log and the PR body.
      const text = redactRemote(data.toString("utf8"));
      if (stream === "stdout") stdoutCaptured = appendCapped(stdoutCaptured, text, MAX_CAPTURED_CHARS);
      else stderrCaptured = appendCapped(stderrCaptured, text, MAX_CAPTURED_CHARS);

      const capped = stream === "stdout" ? stdoutStreamCapped : stderrStreamCapped;
      if (capped) return;

      const streamed = stream === "stdout" ? stdoutStreamedChars : stderrStreamedChars;
      if (streamed + text.length > STREAM_CAP_CHARS) {
        const remaining = Math.max(0, STREAM_CAP_CHARS - streamed);
        if (remaining > 0) {
          if (stream === "stdout") stdoutPending += text.slice(0, remaining);
          else stderrPending += text.slice(0, remaining);
        }
        flush(stream);
        emit({
          type: "verification_output",
          kind,
          stream,
          chunk: "[... output still captured, no longer streamed ...]",
        });
        if (stream === "stdout") {
          stdoutStreamCapped = true;
          stdoutStreamedChars = STREAM_CAP_CHARS;
        } else {
          stderrStreamCapped = true;
          stderrStreamedChars = STREAM_CAP_CHARS;
        }
        return;
      }

      if (stream === "stdout") {
        stdoutPending += text;
        stdoutStreamedChars += text.length;
        if (stdoutPending.length >= FLUSH_CHARS) flush("stdout");
      } else {
        stderrPending += text;
        stderrStreamedChars += text.length;
        if (stderrPending.length >= FLUSH_CHARS) flush("stderr");
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk));

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearInterval(flushTimer);
      flush("stdout");
      flush("stderr");

      const durationMs = Date.now() - startedAt;
      const result: CommandResult = {
        kind,
        command,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs,
        stdoutTail: tail(stdoutCaptured, PERSIST_TAIL_CHARS),
        stderrTail: tail(stderrCaptured, PERSIST_TAIL_CHARS),
      };
      emit({
        type: "verification_command_finished",
        kind,
        exitCode: result.exitCode,
        durationMs,
        timedOut,
      });
      resolve(result);
    }

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function describeFailure(result: CommandResult): string {
  if (result.timedOut) {
    return `\`${result.command}\` timed out after ${Math.round(result.durationMs / 1000)}s`;
  }
  if (result.exitCode === null) {
    return `\`${result.command}\` could not be started: ${
      result.stderrTail || result.stdoutTail || "unknown error"
    }`;
  }
  return `\`${result.command}\` exited ${result.exitCode}`;
}

/** The four possible commands on a repository, `undefined` where unconfigured. */
type ConfiguredCommands = Partial<Record<VerificationKind, string>>;

function commandsFor(repo: RepoRow): ConfiguredCommands {
  const commands: ConfiguredCommands = {};
  if (repo.verifyInstall) commands.install = repo.verifyInstall;
  if (repo.verifyBuild) commands.build = repo.verifyBuild;
  if (repo.verifyTest) commands.test = repo.verifyTest;
  if (repo.verifyLint) commands.lint = repo.verifyLint;
  return commands;
}

/**
 * Runs a repository's configured verification commands against a workspace.
 *
 * Order is install → build → test → lint (§6.2): install and build are
 * prerequisites, so a failure in either stops the run before the next command
 * spawns; test and lint are independent, so both run and both are reported
 * even when test fails first.
 *
 * A non-zero exit, a timeout, or a spawn failure on `install` is `errored`,
 * never `failed` — an environment problem, not a verdict on the code (§6.3).
 * The same is true of a timeout or spawn failure on any other command: a
 * killed or never-started process has no verdict.
 */
export async function runVerification(
  repo: RepoRow,
  workspacePath: string,
  emit: (event: PipelineEvent) => void,
): Promise<VerificationOutcome> {
  const commands = commandsFor(repo);
  const configured = (["install", "build", "test", "lint"] as const).filter(
    (kind) => commands[kind] !== undefined,
  );

  if (configured.length === 0) {
    return { status: "skipped", reason: "no_commands_configured" };
  }

  if (!isInsideWorkspace(resolveWorkspacesDir(), workspacePath)) {
    return {
      status: "errored",
      reason: "The task workspace path is outside the workspaces directory.",
      results: [],
    };
  }

  const timeoutMs = (repo.verifyTimeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
  emit({ type: "verification_started", commands: configured });

  const results: CommandResult[] = [];

  for (const kind of ["install", "build"] as const) {
    const command = commands[kind];
    if (!command) continue;

    const result = await runCommand({ kind, command, cwd: workspacePath, timeoutMs, emit });
    results.push(result);

    if (result.exitCode === null) {
      // Timeout or spawn failure — no verdict, regardless of which command.
      return { status: "errored", reason: describeFailure(result), results };
    }
    if (kind === "install" && result.exitCode !== 0) {
      return { status: "errored", reason: describeFailure(result), results };
    }
    if (result.exitCode !== 0) {
      // `build` failed with a real exit code: a code failure, and test/lint
      // would only report cascading noise against a broken build.
      return { status: "failed", results, failed: [result] };
    }
  }

  const failed: CommandResult[] = [];
  for (const kind of ["test", "lint"] as const) {
    const command = commands[kind];
    if (!command) continue;

    const result = await runCommand({ kind, command, cwd: workspacePath, timeoutMs, emit });
    results.push(result);

    if (result.exitCode === null) {
      return { status: "errored", reason: describeFailure(result), results };
    }
    if (result.exitCode !== 0) failed.push(result);
  }

  return failed.length > 0 ? { status: "failed", results, failed } : { status: "passed", results };
}
