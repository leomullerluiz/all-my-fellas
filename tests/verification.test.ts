import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RepoRow } from "@/server/db/schema";
import type { PipelineEvent } from "@/server/events/store";

/**
 * The mechanical verification runner, in isolation — no DB, no stage wiring.
 * Commands are Node one-liners (`node -e ...`) rather than shell builtins, so
 * the same tests behave identically on POSIX and Windows.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-test-"));
process.env.WORKSPACES_DIR = tempDir;

let splitCommand: typeof import("@/server/pipeline/verification").splitCommand;
let runVerification: typeof import("@/server/pipeline/verification").runVerification;

const workspacePath = path.join(tempDir, "task_1");

beforeAll(async () => {
  fs.mkdirSync(workspacePath, { recursive: true });
  const mod = await import("@/server/pipeline/verification");
  splitCommand = mod.splitCommand;
  runVerification = mod.runVerification;
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A Node one-liner as a single, quoted command string.
 *
 * `splitCommand` understands both quote characters but not escaping, so the
 * script itself must use double quotes for any JS string literals — the
 * outer wrapping uses single quotes, matching what `createRepoSchema` would
 * accept in practice (it rejects a literal backslash outright).
 */
function node(script: string): string {
  return `"${process.execPath}" -e '${script}'`;
}

function repoFixture(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: "repo_1",
    name: "acme/app",
    provider: "github",
    url: "https://github.com/acme/app",
    defaultBranch: "main",
    credentialRef: null,
    credentialUsername: null,
    apiBaseUrl: null,
    context: null,
    verifyInstall: null,
    verifyBuild: null,
    verifyTest: null,
    verifyLint: null,
    verifyTimeoutSeconds: 600,
    createdAt: 0,
    ...overrides,
  };
}

function collectEvents(): { events: PipelineEvent[]; emit: (event: PipelineEvent) => void } {
  const events: PipelineEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

describe("splitCommand", () => {
  it("splits on whitespace", () => {
    expect(splitCommand("npm run build")).toEqual(["npm", "run", "build"]);
  });

  it("honors simple quoting so a quoted argument stays one token", () => {
    expect(splitCommand("node -e \"console.log(1)\"")).toEqual(["node", "-e", "console.log(1)"]);
    expect(splitCommand("poetry run pytest -q")).toEqual(["poetry", "run", "pytest", "-q"]);
  });
});

describe("runVerification — skip and short-circuit", () => {
  it("skips with zero commands when nothing is configured", async () => {
    const { events, emit } = collectEvents();
    const outcome = await runVerification(repoFixture(), workspacePath, emit);
    expect(outcome).toEqual({ status: "skipped", reason: "no_commands_configured" });
    expect(events).toHaveLength(0);
  });

  it("passes when every configured command exits 0", async () => {
    const repo = repoFixture({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(0)"),
      verifyTest: node("process.exit(0)"),
      verifyLint: node("process.exit(0)"),
    });
    const { emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);
    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") {
      expect(outcome.results.map((r) => r.kind)).toEqual(["install", "build", "test", "lint"]);
      expect(outcome.results.every((r) => r.exitCode === 0)).toBe(true);
    }
  });

  it("stops before test/lint when build fails, and reports it as failed", async () => {
    const repo = repoFixture({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(1)"),
      verifyTest: node("process.exit(0)"),
      verifyLint: node("process.exit(0)"),
    });
    const { emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      // Exactly two rows: install (passed) and build (failed) — test and
      // lint never spawn.
      expect(outcome.results.map((r) => r.kind)).toEqual(["install", "build"]);
      expect(outcome.failed.map((r) => r.kind)).toEqual(["build"]);
    }
  });

  it("still runs lint after test fails, and reports both", async () => {
    const repo = repoFixture({
      verifyInstall: node("process.exit(0)"),
      verifyBuild: node("process.exit(0)"),
      verifyTest: node("process.exit(1)"),
      verifyLint: node("process.exit(0)"),
    });
    const { emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.results.map((r) => r.kind)).toEqual(["install", "build", "test", "lint"]);
      expect(outcome.failed.map((r) => r.kind)).toEqual(["test"]);
    }
  });

  it("treats a non-zero install exit as errored, never failed", async () => {
    const repo = repoFixture({
      verifyInstall: node("process.exit(1)"),
      verifyBuild: node("process.exit(0)"),
    });
    const { emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);
    expect(outcome.status).toBe("errored");
    if (outcome.status === "errored") {
      expect(outcome.results.map((r) => r.kind)).toEqual(["install"]);
    }
  });

  it("errors (not a zero exit, not an empty result) when the binary cannot be spawned", async () => {
    const repo = repoFixture({
      verifyInstall: "this-binary-does-not-exist-anywhere --version",
    });
    const { emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);
    expect(outcome.status).toBe("errored");
    if (outcome.status === "errored") {
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].exitCode).toBeNull();
      expect(outcome.reason).toBeTruthy();
    }
  });
});

describe("runVerification — timeouts", () => {
  it("kills a command that outlives its timeout and reports timedOut with a null exit code", async () => {
    const repo = repoFixture({
      verifyInstall: node("setTimeout(() => {}, 30000)"),
      verifyTimeoutSeconds: 30, // clamped elsewhere; this test bypasses the schema bound intentionally
    });
    // Directly exercise a short timeout by overriding at the call site is not
    // possible without a repo field below 30s, so this uses the runner's
    // lower-level guarantee instead: a process that does not exit inside the
    // configured window is killed and reported, not silently awaited forever.
    const { emit } = collectEvents();
    const start = Date.now();
    const outcomePromise = runVerification(
      { ...repo, verifyTimeoutSeconds: 1 },
      workspacePath,
      emit,
    );
    const outcome = await outcomePromise;
    const elapsedMs = Date.now() - start;

    expect(outcome.status).toBe("errored");
    if (outcome.status === "errored") {
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].timedOut).toBe(true);
      expect(outcome.results[0].exitCode).toBeNull();
    }
    // The timeout is ~1s; this should resolve well under the 30s the child
    // asked to sleep for, proving the process was actually killed rather
    // than awaited to completion.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);
});

describe("runVerification — output capture", () => {
  it("persists only the tail of a large stdout, capped at 8KB", async () => {
    const repo = repoFixture({
      verifyInstall: node(
        'for (let i = 0; i < 20000; i++) { process.stdout.write("line-" + i + "\\n"); }',
      ),
    });
    const { emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);
    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") {
      const [result] = outcome.results;
      expect(result.stdoutTail.length).toBeLessThanOrEqual(8 * 1024);
      // The tail, not the head: the last line written must be present, the
      // first must not.
      expect(result.stdoutTail).toContain("line-19999");
      expect(result.stdoutTail).not.toContain("line-0\n");
    }
  });
});

describe("runVerification — redaction", () => {
  it("redacts a credential-bearing remote URL from both persisted and streamed output", async () => {
    // Install/build output can legitimately echo a credential-bearing URL —
    // e.g. a private git dependency failing to resolve. Spec §11.3 requires
    // every persisted and streamed chunk to pass through `redactRemote`.
    const repo = repoFixture({
      verifyInstall: node(
        'process.stdout.write("Cloning https://x-access-token:ghp_secretvalue123@github.com/acme/private.git\\n"); process.exit(1)',
      ),
    });
    const { events, emit } = collectEvents();
    const outcome = await runVerification(repo, workspacePath, emit);

    expect(outcome.status).toBe("errored");
    if (outcome.status === "errored") {
      const [result] = outcome.results;
      expect(result.stdoutTail).not.toContain("ghp_secretvalue123");
      expect(result.stdoutTail).toContain("https://***@github.com/acme/private.git");
    }

    const streamed = events
      .filter((event) => event.type === "verification_output")
      .map((event) => (event.type === "verification_output" ? event.chunk : ""))
      .join("");
    expect(streamed).not.toContain("ghp_secretvalue123");
  });
});

describe("runVerification — environment allowlist", () => {
  it("gives the child CI and PATH but never a credential-shaped variable", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.GITHUB_TOKEN = "ghp_secret_value";
    process.env.ANTHROPIC_API_KEY = "sk-secret-value";

    try {
      // Forward slashes only: `node()`'s outer quoting is single-quote, and a
      // Windows backslash inside the script would collide with nothing here,
      // but `createRepoSchema` forbids a literal backslash outright, so a
      // real configured command could never contain one either.
      const outputFile = path.join(tempDir, "env-dump.json").split(path.sep).join("/");
      const repo = repoFixture({
        verifyInstall: node(
          `require("fs").writeFileSync("${outputFile}", JSON.stringify(process.env))`,
        ),
      });
      const { emit } = collectEvents();
      const outcome = await runVerification(repo, workspacePath, emit);
      expect(outcome.status).toBe("passed");

      const dumped = JSON.parse(fs.readFileSync(outputFile, "utf8")) as Record<string, string>;
      expect(dumped.CI).toBe("true");
      expect(dumped.PATH ?? dumped.Path).toBeTruthy();
      expect(dumped.GITHUB_TOKEN).toBeUndefined();
      expect(dumped.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});

describe("runVerification — streamed events", () => {
  it("emits started/command_started/finished events for a passing run", async () => {
    const repo = repoFixture({ verifyTest: node('console.log("ok"); process.exit(0)') });
    const { events, emit } = collectEvents();
    await runVerification(repo, workspacePath, emit);

    const types = events.map((event) => event.type);
    expect(types).toContain("verification_started");
    expect(types).toContain("verification_command_started");
    expect(types).toContain("verification_command_finished");
  });

  it("keeps the streamed volume low for a chatty command (buffered, not one event per line)", async () => {
    const repo = repoFixture({
      verifyTest: node(
        'for (let i = 0; i < 10000; i++) { process.stdout.write("x\\n"); }',
      ),
    });
    const { events, emit } = collectEvents();
    await runVerification(repo, workspacePath, emit);

    const outputEvents = events.filter((event) => event.type === "verification_output");
    expect(outputEvents.length).toBeLessThan(100);
  });
});
