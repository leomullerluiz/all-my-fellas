# Retry and Recovery — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Make `POST /api/tasks/:id/retry` deterministic for every way a task
> can reach `FAILED` — including the one it cannot handle at all today — and
> expose retryability in the API so the UI stops offering a button that 409s.
> **Prerequisite:** the pipeline as built: the state machine, the SQLite job
> queue, and the migration runner in `src/server/db/migrations.ts`.
> **Related:** `spec-task-queue.md` (§8.3 — a retry takes a slot and must be
> admission-checked); `spec-code-review.md` (§7, and §15.4, which raised the
> budget question and left it open); `spec-cost-forecast.md` (§4.3 — a granted
> cycle is another Development + review round to forecast);
> `spec-audit-trail.md` (the retry event and the failure cause are one record;
> §12.5 there already documents the same-run-row mechanism behind §8.5 here);
> `spec-mechanical-verification.md` and `spec-homologation-verdict.md` (each adds
> a way to fail and must declare a failure kind in §4.4's enum);
> `spec-multi-provider-repositories.md` (§5 — the migration runner its data-model
> blockquote asked for has landed, and is what §4.4 uses).

---

## 1. Summary

`README.md:48` promises: *"A wrong turn costs one stage, not the run."* The
Retry button does not keep that promise. It fails outright in the most common
terminal case, and in a quieter one it re-runs a stage nobody asked for.

**Retry does not know what failed.** `retryTask` (`orchestrator.ts:733-764`)
reconstructs the failure by scanning `stage_runs` for `status === "failed"` and
taking `.at(-1)`. That is a heuristic over a table never designed to answer the
question, and it is wrong in both directions: it finds nothing when the cause
was a rework exhaustion, and it finds a stale row when an earlier stage failed
and was retried successfully earlier in the task's life.

**Retry has no budget to work with.** When the rework budget runs out
(`state-machine.ts:106-116`), re-running `DEVELOPMENT` puts the task one step
from the same wall. The next reviewer rejection re-exhausts the same budget —
a full Development run and a full review run spent to arrive back where it
started.

**The UI cannot tell.** `canRetry` is `status === "failed"` and nothing else
(`task-actions.tsx:199`), and that alone decides whether the button renders
(`:271`). Capacity only *disables* it (`:275`); nothing consults whether anything
is retryable at all. A button that always 409s is worse than no button, because
the user learns to distrust the one case where it works.

This spec fixes the cause: the terminal transition records **which stage to
re-run and why**, retry reads that instead of guessing, a rework-exhausted retry
**grants one extra cycle**, and `GET /api/tasks/:id` returns a `retry` object so
the button knows its own answer before it is pressed.

---

## 2. Scope

**In scope**

- Persisting the terminal cause — `failed_stage` and `failure_kind` on `tasks` —
  written by the same transition that sets `FAILED` (§4).
- Retry semantics per terminal cause: which stage re-runs, at what attempt (§5).
- A per-task rework budget grant, so a rework-exhausted retry has somewhere to
  go (§6). This is the crux.
- A `retry` signal in the pure state machine, so the transition is computed
  rather than hand-built in the orchestrator (§7).
- Refusing a retry against a workspace the retention job already deleted (§9).
- `retry: RetryAvailability` on `GET /api/tasks/:id`, a coded 409 taxonomy, and
  the toast copy for each code (§10, §11).

**Out of scope**

- **Retrying a `CANCELLED` or `REJECTED` task.** Both are deliberate human acts,
  not failures. `retryTask` already refuses them (`orchestrator.ts:737-739`);
  §10.3 keeps the refusal with a message that explains rather than declines.
- **Automatic retry of a terminal task.** Job-level retry already covers
  transient failures — three attempts with backoff (`worker/index.ts:29-31`). A
  terminal `FAILED` means that budget is spent; re-running without a human is how
  a broken prompt burns a subscription overnight.
- **Resuming mid-stage.** A retry starts the stage from the top as a new
  `stage_runs` row. Resuming would need session `resume`, which the
  minimum-context handoff deliberately does not use (`README.md:66-71`).
- **Parking a capacity-refused retry in a queue.** `on_queue` and `gate_queued`
  already exist; a third would be a fourth queue state to reason about. The
  button is disabled with the capacity reason instead — §11.
- **Editing a task before retrying.** Edits are restricted to `CREATED`
  (`orchestrator.ts:459-463`). Changing the description between attempts would
  invalidate every artifact already produced — a different feature.

---

## 3. What breaks today

### 3.1 The four defects

| # | Where | Defect |
|---|---|---|
| 1 | `execute.ts:299` then `:307` | The run is marked `done` **before** `advanceTask` runs. When `advanceTask` yields a terminal `FAILED`, no `stage_runs` row is `failed`. |
| 2 | `orchestrator.ts:741-745` | `.filter(status === "failed").at(-1)` finds nothing → `GateError("No failed stage was found to retry.")` → 409. |
| 3 | `orchestrator.ts:743` | When an *earlier* stage failed and was retried successfully, `.at(-1)` returns that stale row and retry re-runs the wrong stage. |
| 4 | `task-actions.tsx:199`, rendered at `:271` | `canRetry = status === "failed"` — rendered with no knowledge of whether anything is retryable. `:275` disables it at capacity, which is the only other input. |

Defects 1 and 2 are one bug seen from two ends. Defect 3 is independent and
survives any fix that merely reorders the writes in `execute.ts`.

### 3.2 Both traced

`reworkMaxCycles = 2` (the default — `config/env.ts:151`, wired through
`settings/store.ts:77`):

```
DEVELOPMENT#1 done → CODE_REVIEW#1 done, changes_requested → DEVELOPMENT#2
DEVELOPMENT#2 done → CODE_REVIEW#2 done, changes_requested → DEVELOPMENT#3
DEVELOPMENT#3 done → CODE_REVIEW#3 done, changes_requested
    ├─ execute.ts:299  markStageRunStatus(run, "done")   ← the run is green
    └─ execute.ts:307  advanceTask(stage_succeeded)
         └─ state-machine.ts:108  developmentAttempts (3) > reworkMaxCycles (2)
              └─ terminal FAILED

POST /api/tasks/:id/retry
  └─ orchestrator.ts:742  runs with status "failed" → []
       └─ :745  409 "No failed stage was found to retry."
```

Every run in that trace is `done`; the task is `FAILED`. The only record of the
cause is a prose sentence in `tasks.failure_reason` (`schema.ts:68-69`).

Defect 3, same install, different history:

```
ARCHITECTURE#1 failed (malformed techplan.md, execute.ts:243) → FAILED
  retry → ARCHITECTURE#2 done → PLAN_GATE approved → DEVELOPMENT#1…CODE_REVIEW#3
                                     → budget exhausted → FAILED
  retry → failed runs = [ARCHITECTURE#1] → .at(-1) → re-runs ARCHITECTURE
```

The task is thrown back four stages, the approved plan is replaced, the plan
gate re-opens, and three Development runs are orphaned. No error is raised — the
retry "succeeds".

---

## 4. Recording the terminal cause

### 4.1 Three candidates

**(a) Derive it from the events log.** `task_finished` already carries a `reason`
(`orchestrator.ts:118-122`, `events/store.ts:32`). Rejected: `reason` is a
sentence written for a human, so a copy-edit would become a behaviour change —
and there is no field for the stage that *failed*. `task_finished.stage` carries
`transition.stage`, which for a terminal transition is the terminal stage itself
(`FAILED`, `COMPLETED`, `REJECTED` or `CANCELLED`), never the stage to re-run.

**(b) Mark the reviewing run `"rejected"`.** `STAGE_RUN_STATUSES`
(`stages.ts:161-168`) already contains `"rejected"` and nothing in `src/` writes
it; the only other hit is `RUN_TONES` in `stage-badge.tsx:74`. It is plainly the
slot for "completed, but the verdict sent the task backwards". §4.3 argues it
should be written — and that it must not be what retry reads.

**(c) An explicit pointer on `tasks`**, written by the same statement that sets
`currentStage = 'FAILED'`.

### 4.2 The verdict: an explicit pointer on `tasks`

**Retry reads `tasks.failed_stage` and `tasks.failure_kind`. Nothing else.**

The question retry asks — *which stage do I run, and does it need budget?* — is
one fact about the task, decided at exactly one moment by code that already knows
the answer. Deriving it from a scan is how defects 2 and 3 exist at all: a scan
needs an ordering, and `listStageRuns` has no reliable one (§8.4).

The column is also the only candidate correct for a cause with **no run of its
own**. A rework exhaustion is a property of the *transition*: the run that
triggered it (`CODE_REVIEW#3`) is not the run that re-runs (`DEVELOPMENT#4`). No
per-run status expresses that without a lookup table mapping "run that rejected"
to "stage to re-run" — which is exactly what the column stores, minus the lookup.

### 4.3 On `"rejected"` — what the unused status is for

Write it, for a different reason.

Today a reviewer rejection and a reviewer approval are **indistinguishable in the
timeline**: both render `done` (`page.tsx:151` → `RUN_TONES`,
`stage-badge.tsx:69-75`). Someone reading a failed task sees six green rows and a
red banner and cannot tell which review turned the task around. `RUN_TONES`
already maps `rejected: "danger"`, so the display cost is zero. The verdict is
already extracted at `execute.ts:290-297`; the change is one line further down at
`execute.ts:299`, where the unconditional `markStageRunStatus(stageRunId, "done")`
becomes `"rejected"` when that verdict is `changes_requested`, with the semantics
documented on `STAGE_RUN_STATUSES`:

```ts
/**
 * "failed"   — the stage errored: no artifact, or one that failed validation.
 * "rejected" — the stage completed and produced a valid artifact, but its
 *              verdict sent the task backwards. NOT an error; the run did its
 *              job. Display and audit only: retry reads tasks.failed_stage.
 */
```

**It must not become load-bearing.** A task accumulates one `rejected` run per
rework cycle and only the last is terminal; picking "the last" reintroduces the
ordering fragility of §8.4. Any code reaching for `rejected` to decide control
flow is reproducing the bug this spec removes.

`run.status !== "failed"` in `worker/index.ts:120` stays correct: a `rejected`
run whose job later fails is overwritten to `failed`, which by then is honest.

### 4.4 DDL and migration

One entry appended to `MIGRATIONS` (`migrations.ts:39-64`), built from the
`addColumn` helper (`:27-37`) rather than raw SQL, because that is the shape a
`Migration.up` takes:

```ts
{
  name: "terminal cause and per-task rework grant",
  up: (sqlite) => {
    addColumn(sqlite, "tasks", "failed_stage", "TEXT");
    addColumn(sqlite, "tasks", "failure_kind", "TEXT");
    addColumn(sqlite, "tasks", "rework_budget_grant", "INTEGER NOT NULL DEFAULT 0");
    // the §4.5 backfill runs here, in the same transaction as the version bump
  },
}
```

All three are addable: SQLite's `ALTER TABLE … ADD COLUMN` accepts `NOT NULL`
with a constant default, which is exactly what migration 0 already does for
`require_human_code_review` (`migrations.ts:43-48`).

> **Corrected from v0.1.** An earlier draft also added the three columns to
> `bootstrap.sql.ts:23-39`. That is wrong here. The bootstrap creates *missing
> tables*; migrations evolve *existing* ones (`client.ts:29-31`), and every
> column added after v0 — `require_human_code_review`, `credential_ref`,
> `credential_username`, `api_base_url` — lives only in `migrations.ts`.
> `tests/migrations.test.ts:69-79` asserts that the bootstrap does **not** create
> `require_human_code_review`, with the comment "that is the whole reason
> migrations exist rather than editing the bootstrap DDL". Editing the bootstrap
> would not break that test, but it would put the same column in two places that
> can drift, and would make the fresh-database path stop exercising the
> migration. **`bootstrap.sql.ts` is not touched.** A new *table* would be the
> opposite case — that goes in the bootstrap alone (`tests/migrations.test.ts:113-152`).

`src/server/db/schema.ts`'s `tasks` table gains the same three columns
(`failedStage`, `failureKind`, `reworkBudgetGrant`) beside `failureReason`
(`schema.ts:68-69`). That is not optional plumbing: `TaskRow` is
`typeof tasks.$inferSelect`, and both `contextFor`'s `task.reworkBudgetGrant`
(§6.2) and `setTaskStage`'s `extra: Partial<TaskRow>` (`service.ts:402-408`)
type-check against it.

```ts
// stages.ts — why a task reached FAILED. Decides what a retry re-runs (§5).
export const FAILURE_KINDS = [
  "stage_error",       // the agent session, the workspace or a git command threw
  "artifact_invalid",  // the produced document failed validateArtifact
  "no_commits",        // DEVELOPMENT left nothing on the branch (execute.ts:283-287)
  "rework_exhausted",  // a reviewer rejected with the shared budget already spent
  "delivery_failed",   // the push or the change-request call failed
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
```

`StageJobError` (`execute.ts:52-61`) gains `kind: FailureKind`, defaulting to
`"stage_error"`. `execute.ts` throws it from eleven places; the default is right
for eight of them, so exactly three declare a kind: `:244` → `artifact_invalid`,
`:286` → `no_commits`, `:389` → `delivery_failed`. `:218` — the `runStage`
catch — is `stage_error` and needs no declaration, and neither do the missing-row
and missing-input guards (`:94`, `:118`, `:120`, `:124`, `:344`, `:347`, `:349`).
`worker/index.ts:134-138` forwards it on the `stage_failed` signal, which gains a
`failureKind?: FailureKind` field (`state-machine.ts:33`).

New kinds belong to whichever spec introduces them — `FAILURE_KINDS` is a const
union and `RETRY_PLAN` (§5) a total `Record`, so the compiler asks.

### 4.5 Backfill

Pre-migration rows have `failed_stage = NULL`. **They are not run through the old
heuristic at runtime** — that would keep defect 3 alive indefinitely. The
migration backfills once, where the heuristic is at least defensible, and leaves
the rest explicitly unknown:

```sql
UPDATE tasks
   SET failed_stage = (SELECT r.stage FROM stage_runs r
                        WHERE r.task_id = tasks.id AND r.status = 'failed'
                     ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1),
       failure_kind = 'stage_error'
 WHERE current_stage = 'FAILED';
```

A task with no `failed` run keeps `NULL`, and §10.3 refuses its retry with
`no_failed_stage` rather than guessing. On a single-user install that is a
handful of rows, and an honest refusal beats a wrong re-run.

---

## 5. Retry semantics per terminal cause

The mapping is a total, pure table — not a chain of `if`s in the orchestrator:

```ts
// state-machine.ts
type RetryPlan = {
  stage: Stage;                  // what re-runs
  grantReworkCycles: number;     // extra cycles this retry buys the task
  needsBranchHistory: boolean;   // the branch's commits must still be on disk (§9)
};
const RETRY_PLAN: Record<FailureKind, (failedStage: Stage) => RetryPlan> = { … };
```

| `failure_kind` | `failed_stage` | Re-runs | Attempt | Grant | Needs branch history |
|---|---|---|---|---|---|
| `stage_error` | the stage that threw | same stage | `countStageRuns + 1` | 0 | only for `CODE_REVIEW`, `QA`, `PO_HOMOLOGATION`, `DELIVERY`, or `DEVELOPMENT` past attempt 1 |
| `artifact_invalid` | the stage | same stage | `countStageRuns + 1` | 0 | same rule |
| `no_commits` | `DEVELOPMENT` | `DEVELOPMENT` | `countStageRuns + 1` | 0 | no |
| `rework_exhausted` | `DEVELOPMENT` | `DEVELOPMENT` | `countStageRuns + 1` | **1** | **yes** |
| `delivery_failed` | `DELIVERY` | `DELIVERY` | `countStageRuns + 1` | 0 | **yes** |
| *(`CANCELLED` / `REJECTED`)* | — | nothing — §10.3 `not_failed` | — | — | — |

Four things the table settles:

**The attempt number comes from `countStageRuns`, never from the failed row.**
`scheduleStage` already derives it that way (`orchestrator.ts:90`), which is what
keeps the `(task, stage, attempt)` unique index (`schema.ts:101-105`) from
colliding. The transition must stop carrying a rival number — §8.3.

**`rework_exhausted` re-runs `DEVELOPMENT`, never the reviewer.** Re-running
`CODE_REVIEW#4` against unchanged code buys the same rejection at the same price.
What has to change is the code.

**`delivery_failed` is already idempotent.** `executeDelivery` pushes and then
opens the change request (`execute.ts:359-385`). Re-pushing an already-pushed
branch with no new commits is a no-op, so a retry after a change-request failure
costs one git round trip and re-attempts the API call. No special-casing needed,
and none should be added.

**`no_commits` needs no branch history by construction.** Not merely because
Development is the stage that writes commits — on a rework cycle it is not
starting from nothing. The reason is narrower and firmer:
`hasCommitsAheadOfBase` compares the branch to `origin/<base>`, not to the
previous attempt (`execute.ts:283`), so `no_commits` can only fire when the
branch holds **zero** commits ahead of base. A `no_commits` task therefore has no
branch work to lose, at attempt 1 or attempt 4.

---

## 6. The rework budget grant

### 6.1 Why the naive retry loops

Suppose §4 lands and nothing else:

```
retry → DEVELOPMENT#4 → CODE_REVIEW#4 rejects
          └─ state-machine.ts:108   4 > 2   →  FAILED again
```

A full Development run and a full code review spent to land on the identical
message — and the button is still offered, so the obvious next action is to press
it again. **A retry that cannot change the outcome must not be offered.** Either
retry grants headroom, or `rework_exhausted` is not retryable at all — and
refusing it leaves the most common terminal cause with no recovery path, which is
the whole complaint.

### 6.2 The grant: `tasks.rework_budget_grant`

```ts
// orchestrator.ts, contextFor (:65-76)
developmentAttempts: countStageRuns(task.id, "DEVELOPMENT"),
reworkMaxCycles: settings.reworkMaxCycles + task.reworkBudgetGrant,
```

`retryTask` increments the column by `plan.grantReworkCycles` in the same
transaction as the transition. With `reworkMaxCycles = 2`:

| Moment | DEV runs | grant | effective max | terminal? |
|---|---|---|---|---|
| `CODE_REVIEW#3` rejects | 3 | 0 | 2 | yes → `FAILED` |
| retry | 3 | **1** | 3 | no → runs `DEVELOPMENT#4` |
| `CODE_REVIEW#4` rejects | 4 | 1 | 3 | yes → `FAILED` |
| retry again | 4 | **2** | 4 | no → runs `DEVELOPMENT#5` |

Exactly one more swing per retry, each a deliberate, capacity-checked human
action recorded in the events log. The grant is monotonic and per-task, so
raising `reworkMaxCycles` in Settings — which is what the current failure message
tells the user to do — stops being the only option. That instruction is global
and permanent; the grant is local and auditable. The message says which is which:

```
Code review requested changes, but the rework budget of 3 cycle(s)
(2 configured + 1 granted by a retry) is exhausted.
```

### 6.3 Why not "count attempts since the retry"

The alternative stores a retry marker — a timestamp, or the last retried run id —
and redefines `developmentAttempts` as the count *since* it. Rejected:

1. **It changes the meaning of a field every caller shares.**
   `developmentAttempts` means "how many Development runs exist", and
   `scheduleStage` uses the same count to number the run. Two different counts
   under one name in one file is a bug waiting to be written.
2. **It makes the budget silently unbounded.** Each retry resets the window, so
   ten clicks buy ten full budgets with nothing in the database saying so. The
   grant column records exactly how much extra was authorised.
3. **It desynchronises the message from the timeline** — the failure says "2
   cycles" while the timeline shows `attempt 7`. One number, one meaning.

### 6.4 The retried Development run needs no new plumbing

`gatherInputs` (`execute.ts:105-110`) appends `code_review_report`, `qa_report`
and `human_review` whenever `stage === "DEVELOPMENT" && attempt > 1`. A granted
retry always produces an attempt well past 1, so the reports that caused the
exhaustion reach the Developer through the existing path. That is also why
`rework_exhausted` requires branch history (§9): those reports name files and
lines that must still exist on the branch.

---

## 7. State machine changes

### 7.1 Retry becomes a signal

`retryTask` hand-builds a `Transition` (`orchestrator.ts:756-760`) and hands it
to `applyTransition`, bypassing `nextTransition` entirely — so retry can move a
task into any stage without the state machine agreeing, and cannot be tested
without a database. Both are fixed by making retry a signal:

```ts
export type PipelineSignal = | … | { kind: "retry" };

export type PipelineContext = {
  developmentAttempts: number;
  reworkMaxCycles: number;              // settings + tasks.rework_budget_grant
  planGateRequired: boolean;
  humanCodeReviewRequired: boolean;
  failedStage: Stage | null;            // tasks.failed_stage
  failureKind: FailureKind | null;      // tasks.failure_kind
  branchHistoryAvailable: boolean;      // §9
};

export class NotRetryableError extends Error {
  constructor(readonly code: RetryRefusalCode, message: string) { … }
}
```

`nextTransition(current, { kind: "retry" }, context)` throws
`InvalidTransitionError` unless `current === "FAILED"`, throws `NotRetryableError`
for a missing cause or a missing workspace, and otherwise returns
`{ type: "run", stage: plan.stage }`. The **grant** is a side effect and stays in
the orchestrator; the plan that sizes it (`RETRY_PLAN`) is pure and testable with
no DB.

### 7.2 Terminal transitions carry the cause

```ts
| { type: "terminal"; stage: TerminalStage; reason?: string;
    failedStage?: Stage; failureKind?: FailureKind }
```

Two producers set it: `stage_failed` (`state-machine.ts:138-140`) →
`failedStage: signal.stage`, `failureKind: signal.failureKind ?? "stage_error"`;
and `reworkOrFail` (`:106-116`) → `"DEVELOPMENT"` / `"rework_exhausted"`.

`applyTransition`'s terminal branch (`orchestrator.ts:115-125`) writes both in
the `setTaskStage` call it already makes — it already passes `failureReason`
there (`:116`), so this is two more keys in an existing object literal, not a
second write.

A `cancel` or a gate `reject` sets neither. That does **not** make `not_failed` a
data check: per §7.1 it is exactly a stage check (`current !== "FAILED"` →
`InvalidTransitionError`), and it has to be, or a `CANCELLED` task would fall
through to the missing-cause branch and be refused as `no_failed_stage` — the
wrong explanation for a deliberate human act. What the absent columns buy is that
the two refusals can never disagree: a task outside `FAILED` is stopped by the
stage check, and one inside `FAILED` always has a cause unless it predates the
migration (§4.5).

---

## 8. Latent bugs this change trips

### 8.1 The stale cleanup job deletes the workspace mid-retry

This one silently corrupts a run, and retry is what triggers it.

Every terminal transition schedules a cleanup job at
`now + workspaceRetentionDays` (`orchestrator.ts:123`, `:130-134`). A retry moves
the task back into the pipeline but **that job is still pending**. Two ways it
bites: the task sat failed longer than the retention window (default 7 days), so
the job's `runAfter` is already in the past; or the window elapses mid-run.

`claimNextJob` orders candidates by
`PRIORITY_RANK, DIFFICULTY_RANK, asc(runAfter), asc(createdAt)` (`queue.ts:93`).
Both jobs belong to the same task, so priority and difficulty tie and **`runAfter`
decides** — the stale cleanup, dated in the past, sorts ahead of the freshly
enqueued stage job. `tick()` exempts cleanup jobs from the "is the task still
active" guard (`worker/index.ts:153`), so nothing stops it. `executeCleanup` then
runs `removeWorkspace` and nulls `workspacePath` (`execute.ts:404-412`) on a task
that is mid-pipeline.

The symptom is not an error. The next stage calls `prepareWorkspace`, which
re-clones and recreates the branch from `origin/<base>` (`workspace.ts:84-116`) —
an **empty** branch. QA then reviews `"(no changes)"` (`execute.ts:174-179`) and
can approve it.

**Fixed as part of this feature.** `retryTask` drops the scheduled cleanup before
applying the transition, via a new `cancelScheduledCleanup(taskId)` in
`jobs/queue.ts`. `cancelPendingJobs` is not reused: it writes
`lastError = "Task cancelled"` (`queue.ts:134-139`), a lie in the audit trail.

### 8.2 The failure banner survives the retry

`applyTransition`'s `run` branch calls `setTaskStage(taskId, transition.stage)`
with no extra fields (`orchestrator.ts:104`), so `tasks.failure_reason` is never
cleared, and `page.tsx:118-122` renders it whenever non-null. A retried task runs
with a red *"the rework budget of 2 cycle(s) is exhausted"* banner above a live
log showing Development working.

The retry path clears `failureReason`, `failedStage` and `failureKind` with the
stage change. Clearing all three in one place is also what stops §10.1 reporting
a stale cause for a running task.

### 8.3 The attempt number in the retry response is a guess

`retryTask` announces `attempt ${lastRun.attempt + 1}` (`orchestrator.ts:753`)
and returns the same number (`:756-760`). `applyTransition` then ignores it and
calls `scheduleStage`, which computes `countStageRuns(taskId, stage) + 1`
(`:90`).

The two disagree whenever the failed run is not the newest run of its stage —
exactly the defect-3 history in §3.2, where the event says "attempt 2" and the
row created is attempt 3. The wrong number reaches the client and is written to
the event log permanently.

**Remove `attempt` from the `run` variant of `Transition`.** The unique index is
the authority, and one number derived in one place cannot drift from itself.

### 8.4 `listStageRuns` has no deterministic tiebreaker

`listStageRuns` orders by `stageRuns.createdAt` (`service.ts:423`), and
`created_at` defaults to `(unixepoch() * 1000)` (`bootstrap.sql.ts:56`) — that is
**second resolution scaled to milliseconds**. Ids are random UUID slices
(`ids.ts:4-6`), so they break no ties either. Two runs created in the same second
have undefined relative order, and `.at(-1)` over them returns whatever SQLite
happens to produce.

This is a live hazard and the reason §4.2 refuses to build retry on any ordered
scan. It also reaches `decideGate`'s `listStageRuns(...).at(-1)`
(`orchestrator.ts:627`), which picks the run a `human_review` artifact hangs off —
out of scope here, but it should gain `ORDER BY created_at, rowid` at the same
time, which costs one clause.

### 8.5 A job-level retry overwrites the failed attempt's spend

A retryable `StageJobError` sends the worker back through
`executeAgentStage(stageRunId)` with the **same** run row
(`worker/index.ts:94-105`). `startedAt` is reset (`service.ts:460-461`) and the
token and cost fields are overwritten rather than accumulated
(`execute.ts:229-233`), so up to three attempts collapse into one row and
`/usage` under-reports.

Not fixed here, but named because this spec makes retries more common, and
because a human retry (a *new* row) and a job retry (the *same* row) look
identical in the timeline until it is fixed. Ownership is not
`spec-execution-honesty.md`: that spec scopes *out* spend defects, routing them
to `spec-spend-and-operational-control.md` (`spec-execution-honesty.md:93-97`).
The same-run-row mechanism is already written up in `spec-audit-trail.md` §12.5,
which reaches the identical conclusion for `agent_runs`; the `stage_runs`
token/cost half of it belongs with the spend controls.

---

## 9. The workspace and the retention window

The clone and the branch survive a terminal failure until the retention job runs
(`execute.ts:404-412`), which is what makes retry cheap in the common case:
`prepareWorkspace` is idempotent and reuses the existing clone
(`workspace.ts:74-119`).

After cleanup, `workspacePath` is `NULL` but **`branchName` is not cleared** —
`executeCleanup` patches only `workspacePath` (`execute.ts:406`) — so the task
still looks like it has a branch. For an **agent** stage `prepareWorkspace` would
re-clone and recreate that branch from `origin/<base>` — right name, none of the
work — so retrying `QA` on it reviews nothing and can approve nothing.

`DELIVERY` is the one case that already fails closed, and the reason is worth
stating rather than claiming a worse symptom than exists: a `deliver` job routes
straight to `executeDelivery`, which never calls `prepareWorkspace`, and its
`!task.workspacePath` guard (`execute.ts:348-350`) throws before the push. So a
post-cleanup `DELIVERY` retry does not open an empty pull request; it burns a
slot, creates a `stage_runs` row, and lands the task back at `FAILED` with "The
task has no workspace to deliver from." The §9 refusal is still the right answer
— `workspace_gone` explains the retention window, that message explains nothing —
but it is buying a better error, not preventing a corrupt delivery.

**Retry fails closed.** Before applying the transition it checks synchronously —
synchronously because `retryTask`'s body runs inside a better-sqlite3
`db.transaction()`, which cannot await:

```ts
// git/workspace.ts
// NOTE: the module-level `fs` here is `node:fs/promises` (`workspace.ts:1`), so
// this needs its own sync import rather than reusing it.
import { existsSync } from "node:fs";

/** The clone is still on disk with its git directory intact. */
export function workspaceHasGitDir(taskId: string): boolean {
  return existsSync(path.join(workspacePathFor(taskId), ".git"));
}
```

`tasks.workspace_path` alone is not trusted: the directory can also vanish by
hand, or via `docker compose down -v` on the shared volume, without the column
changing.

> A retry whose plan needs branch history is refused with `workspace_gone` when
> the git directory is missing. One that does not — the three pre-Development
> agent stages, and a first-attempt `DEVELOPMENT` — proceeds, and
> `prepareWorkspace` re-clones as it already does.

The refusal is the honest end of the line, not a bug report. §10.1 reports it so
the button is never offered, and the explanation names the retention setting so
the user can raise it before the next task fails rather than after.

---

## 10. API

### 10.1 Retryability on `GET /api/tasks/:id`

The detail response (`api/tasks/[id]/route.ts:39-50`) gains one key:

```ts
export type RetryAvailability =
  | { available: true; stage: Stage; attempt: number; cause: FailureKind;
      /** Extra rework cycles this retry would grant. 0 for most causes. */
      grantsReworkCycles: number }
  | { available: false; code: RetryRefusalCode; reason: string };

export type RetryRefusalCode =
  | "not_failed"       // completed / rejected / cancelled / still running
  | "no_failed_stage"  // pre-migration row with no recorded cause (§4.5)
  | "workspace_gone"   // §9
  | "capacity";        // no slot free right now
```

```json
{
  "task": { "id": "task_9f2…", "status": "failed", "currentStage": "FAILED" },
  "retry": {
    "available": true, "stage": "DEVELOPMENT", "attempt": 4,
    "cause": "rework_exhausted", "grantsReworkCycles": 1
  }
}
```

The same task once the retention job has run:

```json
{
  "retry": {
    "available": false,
    "code": "workspace_gone",
    "reason": "The workspace was removed after 7 days. The branch and its commits are no longer on disk, so there is nothing to re-run Development against."
  }
}
```

`capacity` is reported but **not** treated as hard unavailability by the UI: the
button stays visible and disabled with the reason, matching Start
(`task-actions.tsx:237-243`, `lib/capacity.ts:8-18`). Retry already disables on
capacity today (`task-actions.tsx:275-276`); what is new is that the reason is
rendered beside it rather than hidden in a `title`. The other three codes hide
the button entirely. All of this is state the server already holds, so the cost
is one `existsSync` and one `count(*)` on a response that already issues six
service calls beside the task row (`api/tasks/[id]/route.ts:41-49`).

### 10.2 `POST /api/tasks/:id/retry`

Method, path and status codes are unchanged, and the call is still
**capacity-checked and re-admitted** (`orchestrator.ts:748`). `failed` is
terminal, so the task released its slot when it failed; re-entering the pipeline
is a fresh admission exactly like a start — `spec-task-queue.md` §8.3 lists this
case by name. Dropping the check because "the task already ran once" would let N
failed tasks be retried into N concurrent agent sessions and put the `running`
badge back to lying (§8.1 there).

The **body** does change. Today the route returns `{ transition: retryTask(id) }`
and nothing else (`api/tasks/[id]/retry/route.ts:18`), with the attempt number
riding inside `transition`. §8.3 takes `attempt` off the transition, so it has to
be reported alongside it:

```json
{ "transition": { "type": "run", "stage": "DEVELOPMENT" },
  "attempt": 4, "grantedReworkCycles": 1, "reworkMaxCycles": 3 }
```

`assertSlotAvailable` stays **after** the retryability checks, so a task that
could never be retried says why instead of reporting that the machine is busy.

### 10.3 The 409 taxonomy

`respond.ts:17-19` gains an optional code, so the client branches on something
other than prose: `conflict(message, code?)`.

| Code | HTTP | Raised when | Toast |
|---|---|---|---|
| `not_failed` | 409 | status is `completed`, `rejected`, `cancelled`, or still running | *"Only a failed task can be retried — this one was cancelled."* |
| `no_failed_stage` | 409 | `failed_stage` is `NULL` (§4.5) | *"This task failed before the pipeline recorded which stage to re-run. Create a new task from the same description."* |
| `workspace_gone` | 409 | §9 | *"The clone for this task was deleted after 7 days. There is no branch left to retry against."* |
| `capacity` | 409 | no slot free | *"\"Refactor the auth guard\" is still running. Retry once it finishes."* — `CapacityError` already names the blocker (`orchestrator.ts:164-169`) |
| — | 404 | task not found | *"That task no longer exists."* |

Each is also reachable as `available: false` from §10.1, so a correct client
never sees them. They exist because a disabled button is a hint, not a guarantee:
a stale tab, a second window, or the retention job firing between render and
click. Same reasoning as `spec-task-queue.md` §7.1, and the same reason
`PATCH /api/tasks/:id` re-reads the stage server-side
(`api/tasks/[id]/route.ts:56-62`).

---

## 11. UI

`TaskControls` takes the availability instead of deriving it — replacing
`const canRetry = status === "failed"` (`task-actions.tsx:199`) with a
`retry?: RetryAvailability` prop.

> **Note — §10.1 alone does not feed this.** The detail page is a server
> component that calls the service layer directly and never fetches
> `GET /api/tasks/:id` (`page.tsx:32-41`), exactly as it already does for
> `capacity()` at `:41`. So `retryAvailability(taskId)` must be an exported
> server function that *both* the route and `page.tsx` call, passed into
> `TaskControls` beside the existing `capacity={slots}` prop (`page.tsx:71-78`).
> Adding the key to the API response only would leave the button unchanged.

The prop drives three cases:

- `available: true` → the button renders labelled with the stage it will run,
  **Retry Developer**, not the generic *"Retry failed stage"*. When
  `grantsReworkCycles > 0` a line below reads *"Grants 1 extra rework cycle (3
  total)."* — the user is authorising spend and should see it first.
- `code: "capacity"` → rendered, disabled, `capacityBlockedReason` in the `title`
  and beside it, exactly as Start behaves.
- any other code → **not rendered**; the `reason` string appears as muted text.
  Explaining beats an inert control.

`ACTION_SUCCESS_TOAST.retry` (`task-actions.tsx:158-163`) becomes stage-specific
— *"Re-running Developer (attempt 4)."* — read from the response rather than
guessed (§8.3).

The detail header gains a `rework +1` badge beside the existing ones
(`page.tsx:81-96`) when `reworkBudgetGrant > 0`. It permanently changes how the
task will be judged and should not be discoverable only by reading a failure
message.

---

## 12. Events

One typed event replaces the free-text `log` at `orchestrator.ts:750-754`:

```ts
| { type: "task_retried"; stage: Stage; attempt: number;
    cause: FailureKind; grantedReworkCycles: number }
```

The current line is prose carrying a number that can be wrong (§8.3); a typed
event with the real attempt lets the timeline mark "retried here" distinctly
instead of burying it among agent chatter. `spec-audit-trail.md` owns rendering.

`task_finished` also gains `failureKind`, so the cause is in the event stream and
not only on the task row — an SSE client that missed the row update should not
have to re-fetch to learn why a task stopped.

---

## 13. Test plan

**State machine (pure, no DB)**

- `nextTransition("FAILED", { kind: "retry" }, ctx)` returns `run` at
  `ctx.failedStage`, parameterised over all five `FailureKind` values.
- Non-`FAILED` current stage → `InvalidTransitionError`, parameterised over
  `COMPLETED`, `REJECTED`, `CANCELLED`, `DEVELOPMENT`.
- `failedStage: null` → `NotRetryableError("no_failed_stage")`.
- `branchHistoryAvailable: false` → `NotRetryableError("workspace_gone")` for
  `rework_exhausted`, `delivery_failed` and `stage_error` at `QA`; **allowed**
  for `stage_error` at `ARCHITECTURE` and for `no_commits`.
- `RETRY_PLAN` is total over `FAILURE_KINDS` — a type-level assertion, so adding
  a kind without a plan fails the build.
- **The grant, i.e. the §6.2 table executed:** `{max: 2, attempts: 3, grant: 0}`
  terminates; `grant: 1` returns `run DEVELOPMENT`; `{attempts: 4, grant: 1}`
  terminates again.
- `reworkOrFail`'s terminal carries `failedStage: "DEVELOPMENT"` and
  `failureKind: "rework_exhausted"`.
- **Existing suite, not new coverage:** dropping `attempt` from the `run` variant
  (§8.3) invalidates all fourteen `attempt:` assertions in
  `tests/state-machine.test.ts` — `:22`, `:37`, `:41`, `:57`, `:63`, `:75`,
  `:85`, `:107`, `:127`, `:175` (parameterised, three cases), `:199`, `:212`,
  `:222`, `:237`. Every one is a `toEqual`, so they must be narrowed to
  `{ type: "run", stage }` in the same commit; the compiler will not catch them,
  because `toEqual` takes `unknown`.

**Artifacts**

- A `changes_requested` verdict marks the run `"rejected"`, still saves the
  artifact, and still advances (§4.3); `approved` still marks it `"done"`.
- A malformed artifact still marks the run `"failed"` — `rejected` and `failed`
  never collide.

**API**

- `GET /api/tasks/:id` returns the right stage and attempt for each
  `FailureKind`, and the right refusal code for cancelled, rejected, completed,
  running, missing-cause and missing-workspace.
- `POST …/retry` on a rework-exhausted task: 200, `rework_budget_grant` up by
  exactly 1, a `DEVELOPMENT` run at `countStageRuns + 1`, and
  `failure_reason` / `failed_stage` / `failure_kind` cleared.
- Each 409 code is returned in the `code` field, parameterised.
- Retry at capacity → 409 `capacity` with **no** grant written: the check and the
  increment share one transaction.

**Integration**

- **Defect 3 regression:** `ARCHITECTURE#1` fails → retry → succeeds → the task
  later fails on `rework_exhausted`. The second retry runs `DEVELOPMENT`, not
  `ARCHITECTURE`.
- **§8.1 regression:** a task whose pending cleanup job has a `runAfter` in the
  past is retried; the job is dropped, the workspace survives the retried run,
  and a new cleanup is scheduled only when the task terminates again.
- A retried `DEVELOPMENT` run receives `code_review_report` and `qa_report` in
  its inputs (attempt > 1, `execute.ts:105-110`).
- `delivery_failed` retried after a successful push and a failed change-request
  call: the re-push is a no-op and the change request is opened.
- Two retries leave `rework_budget_grant = 2` and allow two extra Development
  runs, not four.

**Component**

- `TaskControls` renders the stage-specific label for `available: true`, renders
  disabled-with-reason for `capacity`, and renders **no button** for
  `workspace_gone` / `not_failed` / `no_failed_stage` — only the reason text.
- The grant warning appears whenever `grantsReworkCycles > 0`.

---

## 14. Phasing

**Phase A — record the cause.** The three columns, `FailureKind`, terminal
transitions carrying it, the backfill, and `retryTask` reading it instead of
scanning; plus §8.1 and §8.2, both live bugs independent of anything later. This
alone turns the common 409 into a working retry for four of the five causes and
removes the wrong-stage re-run. Independently valuable.

**Phase B — the budget grant.** `rework_budget_grant`, the effective-max in
`contextFor`, the honest failure message, the badge. This is what makes
`rework_exhausted` genuinely recoverable rather than merely re-runnable. Depends
on A; nothing depends on it.

**Phase C — retryability in the API and the UI.** `RetryAvailability`, the coded
409s, the §9 refusal, the stage-specific button, the typed `task_retried` event.
Valuable on its own — it stops the button lying — but pointless before A, since
before A the honest answer for the common case is "not retryable".

---

## 15. Open questions

1. **Should the grant be configurable, or capped?** One cycle per retry,
   uncapped, on the grounds that each retry is a deliberate act with a visible
   cost. A `reworkGrantPerRetry` setting is one field and a cap is one
   comparison; both are refused because neither has an obvious right value, and
   an uncapped grant with a visible counter is easier to reason about than a
   limit users hit and then raise. Revisit once `/usage` shows how often a second
   retry actually happens.
2. **Should a `rework_exhausted` retry offer to raise `reworkMaxCycles` too?**
   The current failure message tells the user to do exactly that
   (`state-machine.ts:113-114`). Global-and-permanent versus local-and-audited —
   this spec picks local, but someone whose every task exhausts the budget is
   being told the wrong thing twice. A product decision, not a technical one.
3. **Should `workspace_gone` offer a full restart?** Everything needed to rebuild
   the branch survives cleanup: the brief, stories and techplan live in
   `artifacts`, which is never cleaned. A "restart from Development" would
   re-clone and re-implement against the approved plan, discarding the lost
   commits. That is a genuinely different action — it throws work away rather
   than resuming it — which is why it is refused here rather than silently
   substituted. It may deserve its own button.
4. **Should `rejected` runs be excluded from `/usage`'s aggregates?**
   `usageByStage` groups over all runs (`service.ts:572-585`), and a rejected
   review cost real money, so it should count. But "cost per *successful* review"
   is the more useful ratio and is not computable without distinguishing them —
   which §4.3 makes possible for the first time. `spec-cost-forecast.md` §4.3 is
   the natural home for the answer.
5. **Retrying a task whose repository connection changed underneath it.** Nothing
   validates that `repoId` still resolves to a reachable connection, or that the
   default branch is still what the branch was cut from, so a retry days later
   can die at `prepareWorkspace` for reasons unrelated to the original failure.
   Verifying access at retry time is cheap — the repos API already does it — but
   it turns a fast local action into a network call, and it is unclear whether
   the check belongs here or in the workspace layer.
6. **Does `no_commits` deserve a grant?** A Developer run that produced nothing
   (`execute.ts:283-287`) consumed a Development attempt without producing
   anything to review, so arguably it should not count against the budget. Not
   granted here, because "the agent produced nothing" is more often a prompt or
   model problem than bad luck, and silently refunding it hides how often it
   happens.
