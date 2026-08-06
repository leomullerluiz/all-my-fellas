# Mechanical Verification — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Per-repository install / build / test / lint commands, run by the
> worker between `DEVELOPMENT` and `CODE_REVIEW`, with the real exit codes
> persisted, streamed, fed to QA, shown on the gates and written into the PR.
> **Prerequisite:** the pipeline as built — the stage set in
> `src/server/pipeline/stages.ts`, the SQLite job queue, the per-task clone.
> **Related:** `spec-code-review.md` (§5 narrowed QA's prompt on the promise that
> QA runs the checks; §7 defines the shared rework budget this spends),
> `spec-task-queue.md` (§8.3 — the verifying task keeps the slot it already
> holds for the whole verify job; the job takes no slot of its own),
> `spec-cost-forecast.md` (§4.3 — rework is the dominant cost variable),
> `spec-multi-provider-repositories.md` (§5 — the `repos` row extended here; §8 —
> the guardrail model these commands sit *outside*), `spec-execution-honesty.md`
> (same defect class in the artifact layer), `spec-audit-trail.md`
> (`verification_runs` is one of its record sources), `spec-retry-recovery.md`
> (environment failures retry, they do not count as rework — §6.3).

---

## 1. Summary

The product tells the user QA runs the test suite, the linter and the build.
Nothing mechanical runs anywhere in the pipeline. QA's verdict is a regular
expression over a `Verdict:` line in a Markdown document the model wrote about
its own work (`src/server/pipeline/artifacts.ts:187-192`). The only mechanical
check is *"the Developer left at least one commit"*
(`src/server/pipeline/execute.ts:283-287`). A pull request can be opened over
code that does not compile, and two agents will have called it approved on the
way there.

This spec adds a **`VERIFICATION` stage**: a non-agent, worker-executed stage
between `DEVELOPMENT` and `CODE_REVIEW` that runs commands the *operator*
configured on the repository connection, records exit codes and durations,
streams output to the live log, and returns red work to the Developer without
paying for a review or a QA session. The verdict is mechanical, so it cannot be
talked around. QA stops claiming to have run anything and receives the real
result as an input.

---

## 2. Scope

**In scope**

- Four commands per repository connection — install, build, test, lint — on the
  `repos` row, autodetected at connection time and editable.
- A `VERIFICATION` stage, a `verify` job kind, and the runner behind them.
- Exit code, duration and truncated output persisted per command.
- Five new `PipelineEvent` variants so the run is visible while it happens.
- A `verification_report` artifact fed to QA as a supplement and to the Developer
  on rework, plus the narrowing of `prompts/qa.md` and the correction of
  `README.md:260-261` and `site/src/lib/content.ts:109`.
- A verification badge on the gate panels and a `## Verification` PR section.
- The process discipline these commands run under (§11).

**Out of scope**

- Container or VM isolation per repository. That is the right long-term answer
  and is separate infrastructure; §11 states the actual trust boundary rather
  than pretending it is narrower.
- Coverage thresholds, flake detection, re-running a failed suite. Red is red.
- An advisory (non-blocking) mode — a recorded-and-ignored failure is the exact
  defect being fixed. Argued in §15.1.
- Parsing test output into structured results. The exit code is the verdict; the
  output tail is context. (§15.3.)
- Per-task command overrides. Commands describe the repository, not the change.

---

## 3. The gap between the claim and the code

`README.md:260-261`: *"Reviewing a diff is cheap; QA runs the test suite, the
linter and the build."* `site/src/lib/content.ts:109` says the same on the
marketing site and `:212` repeats it as the justification for the stage ordering.
`prompts/qa.md:10-11` instructs the agent to *"Run the project's own checks …
Record the exact command and its real outcome."*

None of it is enforced. `executeAgentStage` (`execute.ts:116-308`) runs an LLM
session, checks the returned Markdown has the required `##` headings
(`artifacts.ts:114-138`), saves it, and reads a verdict out of it — fail-closed,
but over prose the model wrote about itself:

```ts
// src/server/pipeline/artifacts.ts:187-192
const value = readField(report, "Verdict")?.toLowerCase() ?? "";
return /\bapproved\b/.test(value) && !/not\s+approved/.test(value)
  ? "approved" : "changes_requested";
```

QA does have `Bash` (`src/server/agents/roles.ts:97-107`) and the read-only
allowlist permits `npm test`, `pytest`, `go test`
(`src/server/pipeline/guardrails.ts:19-54`), so QA *may* run something. Whether
it did is unknowable from the artifact, and whether the command it picked is the
one this repository uses is unknowable too — nothing in the system records what a
repository's checks are.

**Narrowing the prompt cannot fix this.** `prompts/qa.md:47-48` already says *"Do
not claim a suite passed unless you ran it and saw it pass in this session."*
That is unverifiable from the artifact it produces: the document is all the
worker sees, and it is written by the same session being asked not to overstate.
The fix has to be a different actor — the worker runs the commands, reads the
exit codes, and tells the model the answer instead of asking for it.

---

## 4. Placement: a stage, not an inline step

### 4.1 Why not an inline step in `executeAgentStage`

The cheapest-looking option is a block appended to the
`run.stage === "DEVELOPMENT"` branch at `execute.ts:272-288`, touching no stage
list, no job kind and no state machine. It loses on four counts, each a
consequence of what the existing structures already assume:

- **`stage_runs` is the unit of accounting.** Each row carries `startedAt`,
  `finishedAt`, `status` and `error` (`src/server/db/schema.ts:79-107`) and the
  timeline renders one entry per row
  (`src/app/(dashboard)/tasks/[id]/page.tsx:143-163`). Inline, a ten-minute
  `npm ci` is unexplained Developer time and a build failure is a *Developer*
  failure.
- **Retry hits the wrong thing.** `retryTask` (`orchestrator.ts:733-764`) re-runs
  the last `failed` stage run — inline, that is the Developer session, the most
  expensive stage in the pipeline.
- **The error channel is wrong.** A throw inside `executeAgentStage` is a
  `StageJobError`, which the worker eventually turns into a terminal `FAILED`
  task (`src/worker/index.ts:108-142`). Red verification is a rework signal.
- **The board would lie.** `TaskBoard` buckets every task by its `currentStage`
  (`task-board.tsx:148-155`), so the task sits under *Developer* — the one place
  nobody looks for a build log. (`statusForStage`, `stages.ts:103-123`, derives
  the *status* badge, not the column, and returns `running` either way.)

### 4.2 A stage, but not an agent stage

`AGENT_STAGES` (`stages.ts:45-53`) drives four total records: `ROLES`
(`roles.ts:36`) and `models` / `providers` / `maxTurns` in `AppSettings`
(`src/server/settings/store.ts:22-52`). Adding `VERIFICATION` there would force a
prompt file, a model and a turn limit onto a stage that runs no model. So it
joins `STAGES`, `BOARD_STAGES`, `STAGE_LABELS` and `STAGE_TONES`
(`src/components/stage-badge.tsx:11-28`, the other total `Record<Stage, …>` and
the one the spec's first draft missed) and stays out of `AGENT_STAGES` — the
shape `DELIVERY` already has — and gets its own job kind for the same reason
`DELIVERY` has `deliver`:

```ts
// src/server/db/schema.ts:234
export const JOB_KINDS = ["run_stage", "deliver", "verify", "cleanup_workspace"] as const;
```

`scheduleStage` (`orchestrator.ts:87-98`) picks the kind with a ternary today —
`stage === "DELIVERY" ? "deliver" : "run_stage"`. Two special cases is one too
many for a ternary; it becomes a `Partial<Record<Stage, JobKind>>` defaulting to
`run_stage`. `handleJob` (`worker/index.ts:64-81`) gains a `verify` case **and a
`default` with a `never` check** — that switch has no default today, so an
unhandled kind is a silent no-op that completes the job and strands the task.

### 4.3 The revised pipeline

```
… → PLAN_GATE
     └─► DEVELOPMENT          agent  · commits + dev-report.md
          └─► VERIFICATION    worker · install → build → test → lint      ← NEW
               ├─ failed  → DEVELOPMENT     (no review and no QA session paid)
               ├─ errored → FAILED          (environment, not code — §6.3)
               ├─ skipped ─┐
               └─ passed ──┴─► CODE_REVIEW  agent
                                ├─ changes_requested → DEVELOPMENT
                                └─► QA       agent · receives the real results
                                     ├─ changes_requested → DEVELOPMENT
                                     └─► HUMAN_CODE_REVIEW → PO_HOMOLOGATION
                                          → STAKEHOLDER_GATE → DELIVERY → COMPLETED
```

`LINEAR_SUCCESSOR` (`state-machine.ts:70-76`) changes one entry —
`DEVELOPMENT: "VERIFICATION"` — and `VERIFICATION` branches on an outcome, so
like `CODE_REVIEW` and `QA` it is handled explicitly in `nextTransition`.

**The outcome reuses `reviewVerdict`; it does not get a field of its own.** The
shape is identical, and `state-machine.ts:27-29` already records why a second
near-identical field is a mistake: *"two near-identical fields would invite
passing the wrong one."* `skipped` maps to `approved`; `errored` never reaches
the state machine as a success signal at all (§6.3).

---

## 5. Per-repository commands

### 5.1 Data model

```sql
ALTER TABLE repos ADD COLUMN verify_install TEXT;
ALTER TABLE repos ADD COLUMN verify_build   TEXT;
ALTER TABLE repos ADD COLUMN verify_test    TEXT;
ALTER TABLE repos ADD COLUMN verify_lint    TEXT;
ALTER TABLE repos ADD COLUMN verify_timeout_seconds INTEGER NOT NULL DEFAULT 600;
```

`NULL` means "no such command". `''` never reaches the column: the field schema
normalises an empty string to `undefined` exactly as every optional field on
`createRepoSchema` already does (`schemas.ts:122`, `:133`, `:139`), so a
half-cleared form disables the command rather than storing one that spawns
nothing. These are `ALTER TABLE`s, so they belong in `MIGRATIONS`
(`src/server/db/migrations.ts:39-64`) as the third entry, not in
`bootstrap.sql.ts:14-21`, whose `CREATE TABLE IF NOT EXISTS` silently does
nothing to an existing database; `addColumn` (`migrations.ts:27-37`) makes each
idempotent, and the constant `DEFAULT 600` is what makes a `NOT NULL` column
addable by `ALTER TABLE` in SQLite at all. Unlike `spec-code-review.md:333-335`,
which had to warn that no migration runner existed, one exists now.

**The DDL is only half the change.** Every read in this codebase goes through
Drizzle, so the five columns must also be declared on the `repos` table in
`src/server/db/schema.ts:26-43`; without that, `RepoRow` does not carry them and
the runner has no typed way to read the commands it is meant to run. The
convention `credential_ref` established is: a `migrations.ts` entry *and* a
`schema.ts` column, and no `bootstrap.sql.ts` edit.

**Four columns, not an ordered `repo_verification_commands` table.** The members
have different semantics — install and build are prerequisites whose failure
invalidates everything after them, test and lint are independent (§6.2) — and a
generic list erases the distinction that makes the short-circuit rule
expressible. Four is also a ceiling: the stage holds the task's single worker
slot for its whole duration (`src/server/jobs/queue.ts:77-99`). A repository
needing five commands chains them in its own script and points one field at it,
which is also the only way to get a shell (§11.3). §15.2 keeps the escape hatch.

### 5.2 Autodetection at connection time

`POST /api/repos` (`src/app/api/repos/route.ts:38-77`) already runs a live access
check before storing the row. It gains a second step: a throwaway
`git clone --depth 1 --filter=blob:none` into a temp directory under
`resolveWorkspacesDir()`, using the same `provider.transport(...)` credential
attachment `prepareWorkspace` uses (`workspace.ts:88-100`); read the manifests;
delete it. The response gains `suggestedCommands`. **Detection never saves
anything** — the suggestion is prefilled into the form and the operator presses
Save, which matters for §11.1: a stored command is always a human action.

| Marker | install | build | test | lint |
|---|---|---|---|---|
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | `pnpm build` | `pnpm test` | `pnpm lint` |
| `package-lock.json` | `npm ci` | `npm run build` | `npm test` | `npm run lint` |
| `yarn.lock` | `yarn install --frozen-lockfile` | `yarn build` | `yarn test` | `yarn lint` |
| `go.mod` | `go mod download` | `go build ./...` | `go test ./...` | `go vet ./...` |
| `Cargo.toml` | — | `cargo build` | `cargo test` | `cargo clippy` |
| `pyproject.toml` + lock | `poetry install` | — | `poetry run pytest` | `poetry run ruff check .` |
| `pyproject.toml`, no lock | `pip install -e .` | — | `pytest` | `ruff check .` |
| `Makefile` | — | `make build` | `make test` | `make lint` |

Two rules keep the suggestions trustworthy rather than merely plausible: a
JavaScript command is offered only when the matching key exists in
`package.json`'s `scripts`, and a `Makefile` command only when the target is
declared (a `^build:` line, not the presence of the file). Detection failure is
not an error — the connection saves with empty fields and the form says which
manifests were looked for.

### 5.3 Editing

There is no `PUT`/`PATCH` on `/api/repos/:id` today
(`src/app/api/repos/[id]/route.ts` has only `GET` and `DELETE`), so this adds
`PATCH /api/repos/:id` accepting only the five verification fields. The form in
`src/components/repo-manager.tsx:143-251` gains a *Verification* fieldset and
each connected repository gains **Edit commands**. `createRepoSchema`
(`src/server/validation/schemas.ts:80-151`) gains a shared field schema that
rejects `[;&|`$<>(){}\n\r\\]` with *"One command, no shell syntax. To chain
steps, add a script to the repository and point this field at it."*

Those characters are not a sanitiser — the command never reaches a shell
(§11.3), so there is nothing to sanitise. They are a contract: a field that
accepts `a && b` and then runs it as a single argv does nothing useful, and the
operator deserves the error rather than the mystery. `verify_timeout_seconds` is
bounded to `[30, 3600]`.

### 5.4 When no commands are configured

The stage runs, finds nothing to do, and finishes `skipped`.

**Skipped is not green, and every surface must say so.** No commands is the
default state of every existing installation; rendering that as a pass would
recreate this spec's own subject one layer down. The rule, stated once and
referenced from §8, §12 and §13: `verification_finished` carries
`status: "skipped"`; the gate badge reads *"Verification not configured"* in a
neutral tone, never the green badge; the PR body's `## Verification` section is
present and says no commands are configured; the QA supplement says verification
was skipped, and `prompts/qa.md` requires QA to repeat that in `## Checks` rather
than substituting an ad-hoc run of its own.

---

## 6. Execution

### 6.1 The runner contract

```ts
export type VerificationKind = "install" | "build" | "test" | "lint";

export type CommandResult = {
  kind: VerificationKind;
  command: string;              // as configured, for the audit trail
  exitCode: number | null;      // null when killed by the timeout
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;           // after the caps in §11.3
  stderrTail: string;
};

export type VerificationOutcome =
  | { status: "passed";  results: CommandResult[] }
  | { status: "failed";  results: CommandResult[]; failed: CommandResult[] }
  | { status: "skipped"; reason: "no_commands_configured" }
  /** Environment, not code — §6.3. Never a success signal to the state machine. */
  | { status: "errored"; reason: string; results: CommandResult[] };
```

The runner never collapses a spawn error into a falsy value — a deliberate
departure from the surrounding code, see §10.4.

### 6.2 Order and short-circuit

**`install` → `build` → `test` → `lint`**, ordered by dependency between results
rather than by cost. `install` and `build` are prerequisites: a failure in either
makes every later result meaningless, because a suite run against a failed build
reports cascading noise, so **a failure in either stops the stage**. `test` and
`lint` are independent, so **both run even when the first of them fails** and
both are reported — skipping `lint` because `test` failed would spend a whole
extra Developer session discovering a lint error that was already knowable. The
corollary matters for §8.3: on a red run the Developer receives every failure
that was observable, not just the first.

### 6.3 Environment failures are not code failures

`install` differs in kind from the other three. `npm ci` failing because the
registry is unreachable says nothing about the change, and returning the task to
the Developer over it burns the most expensive stage on a problem no code edit
can fix.

**A non-zero exit from `install` is `errored`, not `failed`.** The stage throws a
*retryable* `StageJobError`, entering the worker's existing backoff —
`MAX_JOB_ATTEMPTS = 3`, `RETRY_BACKOFF_MS = [5_000, 20_000]`
(`worker/index.ts:30-31`) — and if it still fails, the task fails technically
with the install stderr tail in `failureReason`. It never consumes a rework
cycle. Timeouts on any command are `errored` for the same reason: a killed
process has no verdict, and treating "we do not know" as "the code is broken" is
the failure mode this spec exists to remove.

### 6.4 Persistence

```sql
CREATE TABLE IF NOT EXISTS verification_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id)      ON DELETE CASCADE,
  stage_run_id  TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,              -- install | build | test | lint
  command       TEXT NOT NULL,
  exit_code     INTEGER,                    -- NULL when killed
  timed_out     INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL,
  stdout_tail   TEXT NOT NULL DEFAULT '',
  stderr_tail   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS verification_runs_task_idx      ON verification_runs(task_id);
CREATE INDEX IF NOT EXISTS verification_runs_stage_run_idx ON verification_runs(stage_run_id);
```

A new table, so `CREATE TABLE IF NOT EXISTS` in `bootstrap.sql.ts` suffices —
it runs on every process start, so an existing database picks the table up with
no migration entry, which is how `attachments` and `task_dependencies` were
added (`tests/migrations.test.ts:113-152` is the shape of the test that proves
it). Only the `repos` columns need a `MIGRATIONS` entry. As in §5.1, the raw DDL
is half the change: a matching `sqliteTable("verification_runs", …)` goes into
`src/server/db/schema.ts` beside the others, since that is what gives the runner,
the gate badge and the PR renderer a typed query path.

**One row per command**, not one row per stage run with a JSON blob: the rows are
the audit record, they are what the PR section renders, and *"how long does
`npm test` take on this repository"* is worth being able to ask in SQL.
`stage_run_id` is `NOT NULL` and the owning `VERIFICATION` run genuinely exists,
so this needs none of the borrowing `decideGate` resorts to when it hangs a
`human_review` artifact off an unrelated stage run (`orchestrator.ts:626-636`).
Both keys cascade; the rows outlive the workspace, which is the point — the clone
is deleted after `workspaceRetentionDays`, but the record of what passed is what
the pull request refers to.

### 6.5 The `verification_report` artifact

`ARTIFACT_TYPES` (`stages.ts:126-136`) gains `verification_report`;
`ARTIFACT_FILENAMES` and `ARTIFACT_SPECS` are total records, so the compiler
forces both entries, with `requiredSections: ["Outcome", "Commands", "Output"]`.
The worker renders it from the rows and calls `saveArtifact` directly, bypassing
`validateArtifact` — the document is machine-generated and validating it would be
the worker checking its own template, exactly as `human_review` is already
produced (`orchestrator.ts:631-636`). Making it an artifact rather than a bespoke
lookup is what lets it reach the Developer through `gatherInputs`
(`execute.ts:87-113`) and the UI through `ArtifactTabs`.

**One line of plumbing there, not none.** `ArtifactTabs`'s `ORDER` array
(`artifact-tabs.tsx:20-27`) is hand-maintained and not total — it is already
missing `code_review_report` and `human_review`. A type absent from it gets
`indexOf === -1`, sorts *ahead* of everything else, and can therefore never be
the tab that opens by default (`artifact-tabs.tsx:58` opens `sorted.at(-1)`).
`verification_report` goes in after `dev_report`. Same non-total-list family as
§10.1 and §10.3, and the reason §13 asserts the tab order.

---

## 7. Streaming

The union at `src/server/events/store.ts:15-33` gains five members:

```ts
| { type: "verification_started"; commands: VerificationKind[] }
| { type: "verification_command_started"; kind: VerificationKind; command: string }
| { type: "verification_output"; kind: VerificationKind;
    stream: "stdout" | "stderr"; chunk: string }
| { type: "verification_command_finished"; kind: VerificationKind;
    exitCode: number | null; durationMs: number; timedOut: boolean }
| { type: "verification_finished";
    status: "passed" | "failed" | "skipped" | "errored"; reason?: string }
```

Five rather than one, because they answer different questions at different times:
what is about to run, what is running, what it is saying, what it concluded, what
the stage decided. Folding output into `{ type: "log" }` would work but loses the
`kind`/`stream` attribution that lets the log tint stderr and lets a later UI
collapse each command into its own block.

`appendEvent` (`events/store.ts:50-74`) does a `max(seq)` read plus an insert
inside a transaction, per event, into a table the SSE route polls every 700 ms
(`src/app/api/tasks/[id]/stream/route.ts:15`). A build printing 20 000 lines
would issue 20 000 transactions — not a live log, a denial of service against the
dashboard. The runner therefore buffers: flush every 500 ms or 4 KB per stream;
64 KB streamed per command, then one chunk saying output is still captured but no
longer streamed; 8 KB persisted per stream; 256 KB read from the child per
stream, ring-buffered. The **tail** survives in every case — a compiler prints its
summary last and a test runner prints its failures last, so a head-truncated log
is reliably the least useful 8 KB available.

`describe()` (`src/components/live-log.tsx:58-99`) is an exhaustive switch with a
declared `string` return and no `default`, so the compiler forces it to handle
the new members. **`toneFor()` (`live-log.tsx:34-56`) does not get that
protection** — it ends in `default: return "text-foreground"` (`:53-54`), so the
five new events compile and render in the default tone until someone updates it
by hand. It and the subscription list (§10.1) are the two places where nothing
catches the omission.

---

## 8. Feeding the real result forward

### 8.1 The QA supplement

The mechanism exists. `StagePromptInput.supplements`
(`src/server/pipeline/prompt.ts:31`) is how the branch diff already reaches QA and
`CODE_REVIEW` (`execute.ts:168-188`), and `buildStagePrompt` renders each as a
section (`prompt.ts:121-124`). One more is appended:

```ts
// executeAgentStage, alongside the existing diff supplement
if (run.stage === "QA" || run.stage === "PO_HOMOLOGATION") {
  const report = latestArtifact(task.id, "verification_report");
  supplements.push({
    label: "Mechanical verification (run by the pipeline, not by you)",
    body: report?.contentMd ?? "No verification has been run for this task.",
  });
}
```

Not fenced — it is structured Markdown, unlike a raw diff. Homologation receives
it too: `PO_HOMOLOGATION` consumes only `stories` and `qa_report`
(`roles.ts:108-118`), so its view of "did the checks pass" is entirely mediated by
QA's prose. One supplement removes that hop.

### 8.2 `prompts/qa.md` narrows — part of the feature, not a follow-up

Step 1 (`prompts/qa.md:10-11`) is replaced:

> **1. Read the verification results you were given.** The pipeline ran this
> repository's configured commands in the task workspace before you were started,
> and their real exit codes are in your input. You did not run them; do not write
> as if you did. If the results say verification was **skipped**, say exactly
> that in `## Checks` and weigh your verdict accordingly — do not run an ad-hoc
> command and present it as the project's checks. You do not know what this
> repository's checks are; the pipeline does.

`prompts/qa.md:47-48` is rewritten to point at the supplied results rather than at
the session. **QA keeps `Bash` and the allowlist stands:** removing `npm test` and
friends from `READ_ONLY_BASH_ALLOWLIST` (`guardrails.ts:19-54`) would also disarm
the Architect, a different role with a different problem, and a QA agent
re-running one failing test to understand a criterion is doing real work. What
changes is *authority* — the rows are the record and the artifact is prose about
them. `ARTIFACT_SPECS.qa_report` keeps its `Checks` section (`artifacts.ts:65`);
its `description` becomes *"QA verdict against the acceptance criteria, given the
pipeline's verification results"*, which is what `describeArtifactContract`
injects into the prompt.

`prompts/developer.md:15-16` keeps its instruction to run the project's checks —
catching a break inside one session is cheaper than a rework cycle — with one
sentence added: the pipeline re-runs them afterwards, so a green claim in
`## Commands Run` (`developer.md:39-41`) that does not survive verification costs
a cycle. `README.md:260-261` and `site/src/lib/content.ts:109`/`:212` are
corrected in the same change; shipping the runner while the README still
attributes the work to QA leaves the product describing a pipeline that does not
exist, which is the defect.

### 8.3 The Developer's rework input

`gatherInputs` (`execute.ts:105-110`) appends the reviewers' reports on rework.
`verification_report` joins the list **first**, because a compile error outranks
an opinion:

```ts
for (const type of [
  "verification_report",   // ← mechanical, and the likeliest reason we are here
  "code_review_report", "qa_report", "human_review",
] as const) { … }
```

This list is also where a real existing bug bites — §10.5.

---

## 9. Red verification and the rework budget

```ts
// nextTransition, alongside the CODE_REVIEW branch at state-machine.ts:191-195
if (current === "VERIFICATION") {
  return signal.reviewVerdict === "approved"
    ? { type: "run", stage: "CODE_REVIEW", attempt: 1 }
    : reworkOrFail(context, "Verification failed");
}
```

A red verification returns to `DEVELOPMENT` **with no `CODE_REVIEW` or `QA`
session started.** That is the economic argument for the whole feature: today,
code that does not compile is read by a reviewer, then read by QA, and only
*maybe* caught — two full agent sessions on a growing diff, per cycle.

### 9.1 The budget is consumed, and here is why

`reworkOrFail` (`state-machine.ts:106-122`) compares
`context.developmentAttempts` against `context.reworkMaxCycles`, and
`developmentAttempts` is `countStageRuns(task.id, "DEVELOPMENT")`
(`orchestrator.ts:71`). **The budget counts Developer sessions, not reviewer
opinions.** A rework triggered by a compile error costs exactly one Developer
session, the same as one triggered by QA. Three alternatives, all rejected:

- **Verification failures are free.** The Developer stage is the most expensive in
  the pipeline (`maxTurns: 80`, `settings/store.ts:86`). An uncapped loop spends
  an entire quota on a task whose build never goes green.
- **A separate allowance.** Two counters that can disagree, two settings to
  explain, and a task that has exhausted one but not the other lands in a state
  neither number describes. `spec-code-review.md:257-266` consolidated three
  rework sources into one budget for exactly this reason; splitting it one feature
  later is a regression.
- **The first verification failure is free.** Tempting — it covers the common
  "forgot to run typecheck" case for at most one extra session. Rejected because
  it makes the budget non-uniform: `reworkOrFail` becomes a function of *which*
  reviewer rejected and *how many times*, and the Settings number stops meaning
  "Developer sessions I am willing to pay for". §15.4 keeps it open; it is a
  product judgement and `/usage` will answer it.

**A compile error burning a rework cycle is correct**, because the cycle is
denominated in what a compile error actually costs: another Developer run. What is
not acceptable is burning one silently, so the terminal message names the cause
instead of using the generic text at `state-machine.ts:113-114`:

```
Verification failed (`npm run build` exited 1), and the rework budget of 2
cycle(s) is exhausted. The last 8 KB of output is on the Verification tab.
Raise "rework cycles" in Settings to allow another attempt.
```

Side effect on ordering: `spec-code-review.md:76-81` conceded that *"there is no
point reviewing code that does not build"* and leaned on the Developer's own
prompt to mitigate it. With `VERIFICATION` in front of `CODE_REVIEW`, the reviewer
is now guaranteed to be reading code that builds whenever a build command exists.

---

## 10. Latent bugs this change would trip

### 10.1 A new event type is invisible in the live log, silently

`LiveLog` subscribes by enumerating event names as **strings**
(`src/components/live-log.tsx:127-143`), and the SSE route dispatches every event
under its own name — `event: ${event.type}` (`stream/route.ts:64`) — so the
generic `addEventListener("message", …)` on the line above never fires.
`describe()` (`live-log.tsx:58-99`) is exhaustive and will fail to compile until
the new variants are handled; the array will not. The result is a feature whose
entire selling point is *"you can watch the build"* shipping with nothing in the
log, a green build, a green typecheck and no warning anywhere.

**The array must be derived, not maintained.** Export a `PIPELINE_EVENT_TYPES`
tuple beside the union in `events/store.ts` with
`satisfies readonly PipelineEvent["type"][]`, and iterate that. `REFRESH_TRIGGERS`
(`live-log.tsx:21-30`) additionally needs `verification_finished`, which changes
the server-rendered timeline and tabs.

### 10.2 Every non-delivery job kind routes to `executeAgentStage`

`orchestrator.ts:95` maps every stage but `DELIVERY` to kind `run_stage`;
`worker/index.ts:66-69` sends every `run_stage` job to `executeAgentStage`; and
`execute.ts:119-121` rejects a non-agent stage with a **non-retryable**
`StageJobError`, which the worker turns into a terminal `FAILED`
(`worker/index.ts:108-142`). Adding `VERIFICATION` to `STAGES` and routing to it
without touching `scheduleStage` kills every task in the system at the same point
with *"VERIFICATION is not an agent stage."* The mirror-image trap is in
`handleJob`: its switch has no `default` and no `never` check, so a kind added to
`JOB_KINDS` without a case is a silent success — the job completes, nothing runs,
and the task hangs at `VERIFICATION` with status `running` forever.

### 10.3 A stage missing from `BOARD_STAGES` vanishes from the board

`STAGES` (`stages.ts:9-26`) and `BOARD_STAGES` (`stages.ts:205-219`) are separate
lists, and the board builds columns by iterating the latter
(`src/components/task-board.tsx:154-160`). A task whose stage is in `STAGES` but
not `BOARD_STAGES` is dropped from `byStage` and rendered nowhere — not in a
column, not in *Not delivered*; it is simply gone from the dashboard until it
moves on. `STAGE_LABELS` (`stages.ts:185-202`) and `STAGE_TONES`
(`stage-badge.tsx:11-28`) are total, so a missing label or tone is a compile
error; neither `BOARD_STAGES` nor `AGENT_STAGES` is total, so neither is caught.
One consequence to carry: `TaskBoard`'s header comment (`task-board.tsx:117-123`)
reasons from "thirteen `BOARD_STAGES` entries, fifteen columns". This change
makes it fourteen and sixteen, and that arithmetic has to be corrected with it or
the next reader inherits a stale justification for the grid breakpoints.

### 10.4 The git helpers report failure as emptiness

`diffAgainstBase` (`src/server/git/workspace.ts:126-136`) returns `""` from its
`catch`, and `hasCommitsAheadOfBase` (`workspace.ts:151-162`) returns `false`.
Both collapse *"the command failed"* into *"there is nothing"*, and the
consequences are already live: a git failure during QA prompt assembly makes
`execute.ts:177` substitute `"(no changes)"`, so QA is told the Developer changed
nothing; and a git failure at `execute.ts:283` produces *"The developer stage
produced no commits on the task branch"*, a non-retryable failure whose diagnosis
is not what happened. The verification runner must not adopt this pattern — a
spawn failure is `errored` with the real reason (§6.3), never a zero exit code and
never an empty result. Fixing the two helpers is small and separable, and it is in
Phase A because the report would otherwise inherit the same lie one level up.

### 10.5 A stale *approved* code review reaches the Developer

`gatherInputs` (`execute.ts:105-110`) takes the **latest** artifact of each type.
Today every rework path passes through `CODE_REVIEW` or later, so the newest
`code_review_report` always belongs to the cycle that just ended. With
`VERIFICATION` in front, a red verification on attempt 2 sends the task back
**before any reviewer ran in this cycle** — so attempt 3's prompt receives cycle
1's `code_review_report`, which says `Verdict: approved`, sitting next to a
verification report saying the build is broken. Handing a Developer a stale
approval as though it described the current code is worse than handing it nothing:
`latestArtifact` gains a variant filtering by the owning `stage_runs.attempt`, and
older reports are omitted rather than included with a caveat the model may not
read.

---

## 11. Security

### 11.1 Operator-configured, and that is the whole model

These are **arbitrary programs executed on the host that runs the worker, outside
the `canUseTool` guard entirely.** `createPermissionGuard`
(`guardrails.ts:169-209`) governs tool calls made by an agent session; the runner
is not a session and makes no tool calls. `DENIED_BASH_PATTERNS` and
`READ_ONLY_BASH_ALLOWLIST` do not apply and are not made to apply — an operator
who configures `make deploy` gets `make deploy`. That is acceptable for one
reason: **the value comes from the operator, through the same dashboard that
already configures which environment variable holds a git credential**
(`schemas.ts:117-127`), and never from a model.

An agent cannot reach `repos` rows, by construction rather than by filter. Every
path-bearing tool call is confined to the workspace by `isInsideWorkspace`
(`guardrails.ts:106-111`, applied at `:197-205`) and `cd` outside it is rejected
(`guardrails.ts:188-193`); the database is not in the workspace
(`docker-compose.yml` mounts `pipeline-data` at `/app/data` and
`pipeline-workspaces` at `/app/workspaces`, with
`DATABASE_URL=file:/app/data/pipeline.db`); and no role has a tool that issues SQL
or an HTTP request — `ROLES` (`roles.ts:36-119`) grants `Read`, `Grep`, `Glob`,
`Edit`, `Write` and `Bash` and nothing else.

### 11.2 The repository's own scripts are a different question

`npm test` runs whatever `package.json`'s `scripts.test` says, and the Developer
can edit `package.json`. **This grants the agent no capability it lacks:**
`checkBashCommand` returns early for a writing role — `if (role.canWrite) return
{ ok: true };` (`guardrails.ts:136`) — so the Developer can already execute
arbitrary code in the workspace during its own session. What verification changes
is the *timing*: the code runs after the session ended, unattended.

Two mitigations are not adopted. Diffing `package.json` scripts and refusing to
verify when they changed fires on the honest case (tasks legitimately change build
scripts) and is evadable through any transitively-imported config file, so it is
theatre. Running the base branch's scripts instead makes a task that adds a test
script unverifiable. What *is* adopted is that §11.3 bounds the blast radius to
code running with the worker's filesystem access and none of its secrets. Real
isolation is a container boundary — §2's out-of-scope item, and the honest answer
for a shared deployment.

### 11.3 Process discipline

| Concern | Rule |
|---|---|
| Shell | **None.** Split into argv by a whitespace-and-quotes splitter, spawned with `shell: false`. A shell forks a process the timeout cannot reliably kill and makes the stored string an injection sink the moment anything is templated into it. §5.3 rejects shell metacharacters at save time so the operator gets an error, not silence. |
| Working directory | `task.workspacePath`, resolved and asserted inside `resolveWorkspacesDir()` before the spawn via `isInsideWorkspace`. A path failing the assertion is `errored`, never a fallback to `process.cwd()`. |
| Environment | An **allowlist**: `PATH`, `HOME`/`USERPROFILE`, `LANG`, `LC_ALL`, `TMPDIR`/`TEMP`, `SystemRoot`, plus `CI=true`. Everything else is dropped — the worker's environment holds `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN` and every variable a connection names, the set `RESERVED_ENV_VARS` (`credentials.ts:19-33`) and the secret-shaped regex at `guardrails.ts:92` exist to keep away from agents. Handing them to a test suite would be a strictly worse leak, since a suite can make network calls. |
| Timeout | `repos.verify_timeout_seconds` per command (default 600, bounded `[30, 3600]`). On expiry the whole **process tree** is killed, not just the direct child: `npm` does the real work in a grandchild, and killing the parent alone orphans it. POSIX: `detached: true` plus `process.kill(-pid, "SIGTERM")`, then `SIGKILL` after 5 s. Windows has neither process groups nor real signals, so there it is `taskkill /pid <pid> /t /f` — both paths are required, since this project runs on Windows as well as in the compose stack. |
| Output caps | 256 KB read per stream, 8 KB persisted, 64 KB streamed (§7). |
| stdin | `"ignore"` in the spawn's `stdio` — `/dev/null` on POSIX, `NUL` on Windows. A command that prompts fails on EOF instead of hanging to the timeout. |
| Concurrency | None. Commands run sequentially; the task already holds one worker slot (`queue.ts:77-99`). |
| Redaction | Every persisted and streamed chunk passes through `redactRemote` (`workspace.ts:45-49`), the treatment stage errors already get at `execute.ts:216`. |

**Throughput cost, stated rather than buried:** at the default
`maxParallelTasks`, a repository whose install + build + test takes eight minutes
blocks every other task for eight minutes per rework cycle (`spec-task-queue.md`
§8.3). That is the price of the guarantee, and `verify_timeout_seconds` is where
an operator decides how much of it to tolerate.

---

## 12. Green verification in the UI and the pull request

`GATE_COPY` (`src/components/task-actions.tsx:17-42`) is a `Record<Gate, …>` and
needs no new entry; `GatePanel` gains a `verification` prop rendered above the
comment box, beside the existing `diffSummary` block (`task-actions.tsx:112-122`).
The detail page computes it next to `diffSummary`
(`src/app/(dashboard)/tasks/[id]/page.tsx:47-57`) from `verification_runs` rather
than the workspace, so it survives cleanup.

| State | Badge | Tone |
|---|---|---|
| passed | `Verification passed · build 42s · test 3m10s · lint 8s` | success |
| skipped | `Verification not configured for this repository` | neutral |
| errored | `Verification could not run: <reason>` | warning |
| failed | `Verification failed: npm run build exited 1` | danger |

`failed` is unreachable at a gate — red routes to `DEVELOPMENT` and never reaches
`HUMAN_CODE_REVIEW` or `STAKEHOLDER_GATE`. It is rendered anyway rather than
asserted away: a badge that assumes an invariant it does not enforce is how a
green light ends up over a red build. `PLAN_GATE` precedes `DEVELOPMENT`, so the
component renders nothing there.

`buildPullRequestBody` (`execute.ts:311-339`) gains a section — expanded, not
inside a `<details>`, because it is the part a reviewer on the provider's side
should not have to click for:

```markdown
## Verification

| Command | Result | Duration |
|---|---|---|
| `npm ci` | ✅ exit 0 | 41s |
| `npm run build` | ✅ exit 0 | 1m12s |
| `npm test` | ✅ exit 0 | 3m10s |

Run by the delivery pipeline in the task workspace at `a1b2c3d`.
```

When skipped the section is still there and reads: *"No verification commands are
configured for this repository, so **nothing was run mechanically**. The reports
below are the agents' own assessments."* An omitted section reads as "not
applicable"; a present one that says what did not happen reads as what it is.

---

## 13. Test plan

**State machine (pure, no DB)**
- `DEVELOPMENT` success → `VERIFICATION`; approved → `CODE_REVIEW` at attempt 1;
  `changes_requested` → `DEVELOPMENT` at `developmentAttempts + 1`; with the
  budget spent → `FAILED`, reason naming verification.
- Regressions: `CODE_REVIEW` approved still → `QA`; `QA` approved still routes on
  `humanCodeReviewRequired`.
- Parameterised over the rejecting source (verification / code review / QA /
  human) that all four share one budget and are indistinguishable to
  `reworkOrFail`.

**Configuration**
- The command schema rejects `a && b`, `a | b`, `a; b`, backticks, `$(…)`,
  newlines and 301 characters; accepts `npm run build` and `poetry run pytest -q`.
- `''` normalises to `undefined` — a cleared field disables the command rather
  than spawning nothing. `verify_timeout_seconds` outside `[30, 3600]` is a 400.
- Detection: a tree with `package-lock.json` whose `scripts` lacks `lint`
  suggests install/build/test and leaves lint empty; a `Makefile` without a
  `build:` target does not suggest `make build`.

**Runner**
- All four exit 0 → `passed`. `build` exits 1 → `failed`, `test` and `lint` never
  spawn, exactly two rows exist. `test` exits 1 → `lint` still runs, both rows
  exist, status `failed`. `install` exits 1 → `errored`, and the thrown
  `StageJobError` is **retryable**.
- Timeout → the grandchild is dead afterwards, `exit_code` is `NULL`, `timed_out`
  is 1, status `errored`.
- The child's environment contains `CI` and `PATH` and does **not** contain
  `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, or any variable a connection names. The
  highest-value test in the file.
- A command absent from `PATH` → `errored` with the spawn error, not exit 0 and
  not an empty result (the §10.4 regression). 1 MB of stdout → `stdout_tail` is
  8 KB and is the **tail**.
- `PIPELINE_EVENT_TYPES` covers every union member — a `satisfies` assertion plus
  a runtime check against the `describe()` switch, so §10.1 cannot recur — and
  10 000 short output lines produce fewer than 100 `verification_output` events.

**API**
- `PATCH /api/repos/:id` updates only verification fields; a body carrying `url`
  or `credentialRef` is a 400, not a silent partial update.
- `POST /api/repos` still succeeds when the detection clone fails, with empty
  suggestions and a stated reason.

**Integration**
- No commands → stage runs, `skipped`, zero rows, task advances to `CODE_REVIEW`,
  and the QA supplement contains "skipped".
- Failing build → no `CODE_REVIEW` or `QA` stage run is created for that cycle,
  and the next `DEVELOPMENT` prompt contains the verification report.
- §10.5 regression: a red verification on attempt 2 produces an attempt-3 prompt
  that does **not** contain cycle 1's `code_review_report`.
- Delivery over a verified branch writes the `## Verification` table; over a
  skipped one, the "nothing was run mechanically" paragraph.

**Component**
- Every non-terminal `Stage` has a `BOARD_STAGES` column and a `STAGE_TONES`
  entry (§10.3 regression), and `GatePanel` shows the neutral badge for
  `skipped` and the success badge only for `passed`, parameterised over all four
  states.
- The two surfaces the compiler does not defend, both asserted because nothing
  else will: `toneFor` returns a non-default tone for a failed and an errored
  `verification_finished` (§7 — the switch has a `default`), and every
  `ArtifactType` appears in `ArtifactTabs`'s `ORDER` (§6.5). The `ORDER`
  assertion fails today for `code_review_report` and `human_review`; adding those
  two is a one-line consequence of writing the test, and it is the same class of
  defect as the rest of §10.

---

## 14. Phasing

**Phase A — the runner and the stage, no configuration UI.** The `repos` columns,
the migration, `verification_runs`, the stage, the `verify` job kind, the events,
the artifact and the routing in §9, plus the §10.4 fix to the two git helpers
whose dishonesty the report would otherwise inherit. Commands are set by hand in
SQLite. Independently valuable: at the end of Phase A the pipeline cannot open a
pull request over code that fails the repository's own build, which is the whole
point, and it needs no new UI.

**Phase B — configuration and detection.** The `PATCH` route, the form fieldset,
the detection clone and the suggestion table. Independently valuable on its own
terms: it turns a feature only its author can enable into one an operator can.

**Phase C — the honest surfaces.** The QA and homologation supplements, the prompt
narrowing, the gate badges, the PR section, and the README and marketing-site
corrections. Valuable independently of B — with commands set by hand from Phase A,
this is what makes the result visible to the humans and agents downstream. Last on
purpose: everything in it consumes data Phase A produces, so none of it can be
built on a guess about that data's shape.

---

## 15. Open questions

1. **Should there be an advisory mode?** A `verificationBlocking: false` setting
   would let a team watch what verification says for a week before letting it
   gate, which is how most CI adoptions actually go. Rejected here because a
   recorded-and-ignored failure is the shape of the defect being fixed, and
   because the flag would have to be surfaced on the badge and in the PR body or
   both would lie. The counter — a team with a flaky suite will otherwise disable
   verification entirely, which is worse — is real. Product decision.
2. **Four fields or an ordered list?** This repository itself has `test`, `lint`,
   `build` *and* `typecheck` (`package.json`), so five things for four slots
   already; today's answer is a repo-side script. If that is the common case
   rather than the exception, the fields become a table and §6.2's short-circuit
   rule needs a per-row `blocking` flag to survive the move.
3. **Structured test results.** JUnit XML or TAP would let the Developer's prompt
   name the three failing tests instead of quoting a log, and make "which test is
   flaky across tasks" answerable. It is a per-ecosystem parser plus a results
   table, and it is worth nothing until the exit code exists — which is what this
   spec builds.
4. **Should the first verification failure be free?** §9.1 argues for uniformity
   and rejects the exemption; the opposing case is that the first red run is
   usually a trivial oversight and a third of a two-cycle budget is harsh. The
   data to settle it — how often a task's *first* verification is red, and whether
   those tasks go on to succeed — exists in `verification_runs` and `stage_runs`
   from Phase A onward.
5. **Monorepos.** The working directory is the workspace root, so a change
   confined to `packages/api` runs the whole repository's suite. Scoping by the
   diff's touched paths needs the package layout, a per-ecosystem problem the size
   of question 3. Until then the escape hatch is a repo-side script that scopes
   itself.
6. **Should `CODE_REVIEW` see the output?** It would not under §8.1. For: a
   reviewer who can see the build succeeded may review differently. Against:
   verification is green by the time `CODE_REVIEW` runs, so the supplement carries
   almost no information and costs context on every review.
