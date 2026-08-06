# Execution Honesty — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Two claims the UI makes that are not true — that a pulsing card
> means an agent is running, and that the pipeline works against GitHub and
> opens pull requests — and the single derivation plus the single abstraction
> that make both true.
> **Prerequisite:** the pipeline as built, with admission control
> (`spec-task-queue.md` §8) and the provider registry
> (`spec-multi-provider-repositories.md` §4.1) already in place.
> **Related:** `spec-task-queue.md` (§8.2 — "admitted" is that spec's admission
> rule, renamed and kept; §8.5 — `promoteQueue` fills the queue this spec makes
> visible); `spec-multi-provider-repositories.md` (§4.1 — the
> `RepositoryProvider` interface every user-visible provider string must flow
> from; §7 — the UI changes that stopped one screen short); `spec-code-review.md`
> (§10.6 — the gate panel whose copy hardcodes "GitHub"); `spec-cost-forecast.md`
> (§7 — the forecast lands on the same card whose status line this spec rewrites);
> `spec-retry-recovery.md` (owns what happens during a backoff; this spec owns
> what the card says during it); `spec-audit-trail.md` (indexes the `pr_opened`
> event whose rendering changes here); `spec-mechanical-verification.md` and
> `spec-homologation-verdict.md` (their verdicts land on the same detail header);
> `spec-spend-and-operational-control.md` (worker liveness — deliberately not
> here; see §2). **That last document does not exist in the repository yet**;
> every reference to it below is a deferral to a spec still to be written, not a
> pointer to a decision already taken elsewhere.

---

## 1. Summary

Two lies, one theme: **the UI must not claim something the database does not
say.**

**Lie one — the pulsing dot.** `README.md:73-76` and
`site/src/lib/content.ts:207` both promise that "a card that says 'an agent is
running' means exactly that". It does not. `statusForStage`
(`src/server/pipeline/stages.ts:103-123`) returns `running` for every
non-terminal, non-gate, non-`CREATED` stage, and the board turns that into a
pulsing dot labelled "An agent is running" (`src/components/task-board.tsx:37`,
`:73-78`). The worker runs exactly one job at a time: `tick()` claims a single
job (`src/worker/index.ts:147`) and awaits it to completion (`:163`) before the
loop sleeps and claims another (`:188`). Set `maxParallelTasks` to 3 — the
setting the product offers, `1..8` in `settings-form.tsx:186-187` — and three
cards pulse while one agent spends.

**Lie two — provider-locked copy.** `src/app/(dashboard)/page.tsx:135` tells a
first-time user the pipeline "needs a GitHub repository to work against";
`src/components/task-actions.tsx:38` tells a GitLab user that "the merge still
happens on GitHub". Thirteen strings across ten files name a host, a
provider-specific credential variable or a change-request kind the connected
repository may not use — while `src/app/(dashboard)/tasks/[id]/page.tsx:113`
two screens away already does it
correctly from `providerFor(task.repo.provider).changeRequestNoun`, and the
provider contract has carried `displayName` and `changeRequestNoun` for exactly
this since `src/server/git/providers/types.ts:83-85`.

The fixes are asymmetric. The first needs a new derived value, computed once,
consumed by three surfaces. The second needs no new data at all — only that
every string reach the abstraction that already holds it, and a rule that stops
the next one being written literally.

---

## 2. Scope

**In scope**

- A single derived notion of **in flight** versus **admitted**, computed
  server-side in one module from the already-written-but-uncalled
  `runningTaskCount()` (`src/server/jobs/queue.ts:61-68`), and consumed by the
  board, the detail page and `GET /api/tasks` (§4).
- What a card shows in each state, including queue depth and position for an
  admitted task whose job has not been claimed (§5).
- The latent bugs the change trips, fixed as part of it (§6).
- Every user-visible provider-specific string, enumerated with its replacement
  (§7), plus the rule and the test that stop the regression (§8).
- Narrowing the two marketing claims — `README.md:73-76`,
  `site/src/lib/content.ts:207` — and the "staffed entirely by Claude agents"
  claim at `site/src/lib/content.ts:25` (§7.5).

**Out of scope**

- **Worker liveness.** Whether the worker is alive, whether it has stalled
  mid-job, and what the UI says when it is gone belong to
  `spec-spend-and-operational-control.md`. This spec makes the badge honest
  about **what is claimed**; that one makes it honest about **whether the worker
  is alive**. The seam is exact: a claimed job whose worker died reads
  identically to a healthy one until a heartbeat says otherwise, and
  `requeueOrphanedJobs` (`src/server/jobs/queue.ts:147-155`) at the next worker
  start is the only recovery that exists today. That spec is not yet written; the
  seam is stated here so it can be, not because it already exists.
- **Running more than one job concurrently.** The other honest answer to "three
  cards pulse, one agent runs" is "run three agents" — a worker architecture
  change with its own cost, quota and guardrail consequences. See §12.2.
- **A new task status.** Rejected in §4.3 — the central design decision here,
  not an omission.
- **The Claude-shaped quota model.** `QUOTA_MODES`
  (`src/components/settings-form.tsx:16-19`) offers "Claude subscription" and
  "Anthropic API key" while `spendToday` (`src/server/usage/quota.ts:56`) sums
  spend from all three backends — the same family of defect, belonging with the
  spend controls in `spec-spend-and-operational-control.md`.
- **Renaming the `pr_opened` event type.** Persisted in `events.type`
  (`src/server/db/schema.ts:179`); a migration decision, left open in §12.5.
  Only its *rendering* changes here.

---

## 3. What is actually true right now

### 3.1 The mechanism, verified

```
web process                          SQLite                       worker process
───────────                          ──────                       ──────────────
startTask()                    tasks.status = 'running'
  assertSlotAvailable()  ─────► (ACTIVE_STATUSES = ['running'],
  advanceTask()                  service.ts:319)
    applyTransition()      ───► jobs(status='pending')
      scheduleStage()                                  ◄────── tick()  worker/index.ts:145
                                                                claimNextJob(maxParallelTasks)
                               jobs.status = 'claimed'  ◄─────  queue.ts:101-106
                                                                await handleJob(job)   :163
                                                                  ── minutes ──
                               jobs.status = 'done'     ◄─────  completeJob()          :164
                                                                sleep(TICK_MS = 1000)  :188
```

Three tasks started with `maxParallelTasks = 3` produce three rows at
`tasks.status = 'running'` and three rows in `jobs`. The worker claims one. The
other two jobs sit at `pending` for as long as the first stage takes — minutes,
routinely.

`claimNextJob` does cap concurrency at `maxParallelTasks`
(`src/server/jobs/queue.ts:86`), but the cap is unreachable above 1: the worker
is a single `while` loop that awaits each job to completion, so `busyTaskIds`
is never longer than one. `spec-task-queue.md` §8.2 keeps the cap deliberately,
as a backstop it expects to be *unreachable* ("it should now be unreachable, and
a test should assert that"); the second-worker rationale is `queue.ts`'s own
docblock (`:7-12`), not §8.2. Either way it is not a statement about how many
agents run.

### 3.2 Why the claim is load-bearing

`spec-task-queue.md` §8 opens with it as a **requirement** — "the `running`
badge must be literally true". §8.1 describes exactly the failure this spec is
about ("four cards would show a pulsing 'an agent is running' dot while nothing
happened") and then rejects, not the queue, but **showing** it: version 0.1 of
that spec proposed a distinct "waiting for a worker slot" state and it was
struck out with "Making the queue visible is worse than not letting it form."
The whole admission-control design exists to protect this one sentence.

It protects it against the wrong thing. Admission control caps how many tasks
are *admitted*; nothing caps or reports how many are *executing*. §8.2 states
the reasoning outright — "Because only active tasks can own jobs, capping
admission at N caps concurrent jobs at N. The worker never has to queue, so
`running` is always truthful." The first sentence is true. The second is false
for every N above 1: one worker draining N admitted tasks queues by
construction. And the product offers `1..8`, with a hint
(`settings-form.tsx:181`) that reads "Keep this at 1 on a Claude subscription",
which is advice about cost, not a warning that the board stops being true.

**The claim becomes false precisely when the user changes the setting the
product offers.** That is the defect.

**This spec revives the state §8.1 rejected, and says so.** §8.1's rejection
rests on a premise — that the queue can be prevented from forming — which holds
only at `maxParallelTasks = 1`. Above 1 the queue forms whether or not it is
rendered, so the choice is no longer "a visible queue versus no queue" but "a
visible queue versus a lying badge", and §8's own requirement decides it. The
`maxParallelTasks = 1` install, where §8.1's premise does hold, is unaffected:
`waiting_for_worker` is empty and the clause is suppressed (§4.5). Open question
2 is where the other resolution — cap the setting at 1 and keep §8.1 intact —
still lives.

### 3.3 The truth is already in the database

`jobs.status = 'claimed'` (`src/server/db/schema.ts:237`, `:252`) means one
thing only: the worker has this job open right now. And the query already
exists — `runningTaskCount()` at `src/server/jobs/queue.ts:61-68`, a
`count(distinct jobs.taskId) where status = 'claimed'`, **called by nothing in
`src/` or `tests/`**. Someone wrote the honest number and never wired it up.
This spec wires it up, after fixing the one thing wrong with it (§6.1).

---

## 4. In flight vs admitted

### 4.1 The two words, defined once

> **Admitted** — the task holds a concurrency slot. `tasks.status = 'running'`,
> per `ACTIVE_STATUSES` at `src/server/tasks/service.ts:319`. This is what
> `capacity()` counts (`src/server/pipeline/orchestrator.ts:187-201`) and what
> `assertSlotAvailable` enforces (`:180-184`). **Unchanged by this spec.**
>
> **In flight** — the worker is executing this task's stage job right now. The
> task has a row in `jobs` with `status = 'claimed'` and
> `kind IN ('run_stage','deliver')`.

Admitted is a fact about the *task*. In flight is a fact about the *worker*.
Conflating them is the bug; naming them separately is most of the fix.

Everything the UI shows derives from the pair, plus the task's own status:

```ts
// src/server/pipeline/execution.ts — new module
export type ExecutionState =
  /** Worker has this task's job open. `job` separates an LLM session from the
   *  delivery job, which pushes and calls a REST API but runs no agent. */
  | { kind: "in_flight"; job: "agent" | "delivery" }
  /** Admitted; job enqueued and eligible, waiting for the worker to reach it. */
  | { kind: "waiting_for_worker"; position: number; depth: number }
  /** Admitted; job back at `pending` with a future `runAfter` after a retryable
   *  failure — worker/index.ts:97-105. */
  | { kind: "retry_backoff"; retryAt: number; attempt: number }
  /** Admitted, but with neither a claimed nor an eligible pending job. Not the
   *  ordinary between-stages gap — that gap does not exist (see below). Either
   *  read skew across the three queries, or a genuinely stranded task. */
  | { kind: "settling" }
  /** Not admitted: CREATED, on_queue, awaiting_gate, gate_queued, terminal. */
  | { kind: "idle" };

export function executionStates(): Map<string, ExecutionState>;
```

`settling` gets its own case rather than collapsing into `waiting_for_worker`
because only one of them has a position: a task with no eligible job is not
queued behind anything, and saying "3rd of 3" about it would be a smaller
version of the lie being fixed.

**Correction to an earlier reading of this state.** There is no between-stages
gap to describe. `scheduleStage` enqueues the next job from inside
`advanceTask`, which the stage itself calls as its last act (`execute.ts:307`
for an agent stage, `:400` for delivery) — *before* the worker marks the
finished job done (`worker/index.ts:164`). So the task holds a claimed job and a
pending one simultaneously for that window, and `in_flight` wins by precedence.
What is left for `settling` is two things, both worth rendering: read skew,
because the three queries below are three statements and a commit can land
between them; and a task genuinely stranded at `running` with nothing queued —
the outcome of the `advanceTask` failure logged at `worker/index.ts:139-141`,
which today produces a permanently pulsing card. Taking the three reads inside
one read-only `db.transaction()` removes the first case and leaves `settling`
meaning only the second. Do that: it costs nothing, and it turns a rare flicker
into a diagnostic. It does not violate the rule at `orchestrator.ts:320-326` —
that rule forbids `promoteQueue` and the transition entry points inside an open
transaction, and this module calls none of them and writes nothing.

### 4.2 Where it is computed

**One module, server-side, three consumers.** `src/server/pipeline/execution.ts`
exports `executionStates()`; the board (`src/app/(dashboard)/page.tsx`), the
detail page (`src/app/(dashboard)/tasks/[id]/page.tsx`) and the list API
(`src/app/api/tasks/route.ts:23-40`) each call it once per render. Both pages
are already `dynamic = "force-dynamic"` (`page.tsx:21`, `tasks/[id]/page.tsx:25`);
the route handler declares no `dynamic` export and needs none — it reads
`request.url` (`route.ts:25`), which makes it dynamic already. The board already
refreshes on a 4-second interval via `AutoRefresh`
(`src/components/auto-refresh.tsx:12`). **No
new polling, no new endpoint, no client-side derivation** — `jobs` is not
exposed by any API, and exposing it so the browser could recompute a five-way
enum would be strictly worse than sending the enum.

Three queries, one round of assembly:

```sql
-- 1. In flight. The `kind` filter is not optional — see §6.1.
SELECT DISTINCT task_id, kind FROM jobs
WHERE status = 'claimed' AND kind IN ('run_stage', 'deliver');

-- 2. The queue, in exactly the order claimNextJob will drain it. A row's index
--    in this result *is* its position; ROW_NUMBER() is shown for clarity only.
--    The NOT IN mirrors queue.ts:98 — claimNextJob skips a job whose task
--    already holds a claimed one, so counting it would put a task in the queue
--    behind itself. Without this the head of the queue is wrong for the whole
--    window described in §4.1.
SELECT j.task_id,
       ROW_NUMBER() OVER (ORDER BY <PRIORITY_RANK>, <DIFFICULTY_RANK>,
                                   j.run_after, j.created_at) AS position,
       COUNT(*)     OVER ()                                   AS depth
FROM jobs j JOIN tasks t ON t.id = j.task_id
WHERE j.status = 'pending' AND j.kind IN ('run_stage', 'deliver')
  AND j.run_after <= :now
  AND j.task_id NOT IN (SELECT task_id FROM jobs WHERE status = 'claimed');

-- 3. Backoff.
SELECT task_id, run_after, attempts FROM jobs
WHERE status = 'pending' AND kind IN ('run_stage','deliver') AND run_after > :now;
```

**No schema change, and nothing to migrate.** All three queries read columns
that exist today (`jobs.kind`, `jobs.status`, `jobs.run_after`, `jobs.attempts`
— `schema.ts:240-258`, `bootstrap.sql.ts:129-140`) and are served by the
existing `jobs_status_run_after_idx`. Nothing is appended to `MIGRATIONS`
(`migrations.ts:39-64`), so neither the `CREATE TABLE IF NOT EXISTS` bootstrap
nor the `PRAGMA user_version` ladder is touched. That is a property to keep: the
whole derivation is a read over data the pipeline already writes.

**`PRIORITY_RANK` and `DIFFICULTY_RANK` must be the ones from
`src/server/jobs/queue.ts:22-26`, exported and reused — not retyped.** A
position computed from a different ordering than the one `claimNextJob` uses at
`queue.ts:93` replaces an old lie with a subtler one: wrong only on the
mixed-priority boards where the number is worth reading.

There is already one duplicate — `orchestrator.ts:261-286` reimplements the
ranking in JavaScript for both `startTasksBatch` and `promoteQueue`, with a
comment at `:255-260` conceding it and explaining why (it sorts fetched rows,
not a query). That is two. Three is where someone changes one and not the
others. The SQL fragments move to a shared export; the JS ranking stays, with a
test asserting the two rank the same fixture identically (§10 — on the
priority/difficulty key only; the tiebreakers are deliberately different and are
not equivalent).

### 4.3 Why this is not a task status

`TASK_STATUSES` (`src/server/pipeline/stages.ts:89-99`) is tempting: add
`waiting_for_worker`, let `StatusBadge` render it
(`src/components/stage-badge.tsx:46-63`), done. **Rejected**, for four reasons
that compound.

1. **`statusForStage` is the derivation rule, and it already has two
   exceptions.** `stages.ts:74-88` documents them at length: `on_queue` and
   `gate_queued` are *not* derived from `currentStage` — they are written
   explicitly by `startTasksBatch` (`orchestrator.ts:406`, `:420`) and
   `decideGate` (`:650`), and `statusForStage` "never produces either itself".
   That comment exists because the exceptions are a wart someone had to explain.
   Two is a wart; three is a pattern, and the pattern is "the status column no
   longer means what its derivation function says". Not, to be precise, a
   migration: `status` is plain `TEXT` with a default and no `CHECK`
   (`bootstrap.sql.ts:28`, `schema.ts:54`), so a new value is addable with no
   DDL at all. The cost is worse than a migration — the value becomes *history*.
   Every row written carries it forever, every reader must keep interpreting it
   (`STATUS_TONES`/`STATUS_LABELS` at `stage-badge.tsx:34-63`, the board's
   `on_queue` split at `task-board.tsx:144`, the status filter), and a value you
   later regret cannot be taken back out. A derived value is deletable in one
   release.

2. **In flight is not a property of the task.** Nothing in the transition
   machinery observes a job being claimed — `claimNextJob` is called by the
   worker and writes `jobs` only (`queue.ts:101-106`). Persisting it means the
   worker writing `tasks.status` on claim and unwriting it at `completeJob`
   (`queue.ts:112`), `failJob` (`:122-131`), the retry-backoff branch
   (`worker/index.ts:104`) and `requeueOrphanedJobs` (`queue.ts:147-155`) —
   four write sites, each a chance to strand a task at a status no transition
   can clear.

3. **A persisted flag goes stale exactly when it matters.** A worker killed
   mid-job leaves it set; `requeueOrphanedJobs` repairs `jobs` at the next start
   and nothing repairs `tasks`. The derived value has nothing to repair: when
   the job row returns to `pending`, the card says "waiting for the worker" on
   the very next render, which is true.

4. **Three definitions of "active" already disagree** (§6.3). A fourth, and
   persisted, is the worst possible addition. Deriving adds none.

**The rule:** persisted status answers *"what did the user or the orchestrator
decide about this task"*. The derived execution state answers *"what is the
worker doing this second"*. Only the first belongs in a column.

### 4.4 Queue depth and position

For a task in `waiting_for_worker`:

- **`position`** — 1-based index in the ordering `claimNextJob` will use,
  counting only *eligible* jobs (`status = 'pending'`, `run_after <= now`,
  `kind IN ('run_stage','deliver')`).
- **`depth`** — the number of eligible jobs in total.

Deliberately excluded from both numbers:

| Excluded | Why |
|---|---|
| `cleanup_workspace` jobs | The task is terminal; no agent, nothing a user is waiting on. Counting them makes "2nd of 3" wrong for the person reading it. |
| Jobs with `run_after > now` | Retry backoff. They are not competing for the next claim; they get `retry_backoff` and a countdown instead. |
| Tasks at `on_queue` / `gate_queued` | Not admitted, no job row exists — `startTasksBatch` parks them *before* `startTask` succeeds and `decideGate` parks them *before* `applyTransition`. They already have their own board column and status label. |

Also excluded, and this one is not optional: a job whose task already holds a
claimed job. `claimNextJob` skips those (`queue.ts:98`), so counting them would
place a task in the queue behind itself for the whole window §4.1 describes.

The caveat the code comment must carry, and the copy need not, is larger than it
first looks. `claimNextJob` has **no `kind` filter at all** — its candidate query
selects every eligible pending job (`queue.ts:88-96`) — so `cleanup_workspace`
interacts with the queue twice, not once:

- A **claimed** cleanup job occupies the worker's single job slot and counts
  toward the cap (`queue.ts:79-86`), delaying the head of the queue by one job.
- A **pending, eligible** cleanup job competes in the same ordering as agent
  work, ranked by *its own task's* priority through the join at `queue.ts:91`.
  Cleanup is enqueued with `runAfter = now + workspaceRetentionDays` days
  (`orchestrator.ts:130-134`), so it is ineligible for most of its life — but
  once that window passes, a completed urgent task's cleanup job can be claimed
  ahead of the task shown at "1st of 3".

So `position` is a statement about ordering **among agent work**, not a promise
about which job the worker claims next and not a promise about wall-clock time
(§6.4). §10's ordering test has to be stated in those terms or it is simply
false.

### 4.5 Wiring, per surface

**Board** — `BoardTask` (`src/components/task-board.tsx:19`) gains
`execution: ExecutionState`. The header counter line at
`src/app/(dashboard)/page.tsx:111-115` changes from

```
3 of 3 slots in use · 2 not started · 1 waiting for approval · $4.12 spent in total
```

to, with the true number first:

```
1 running · 2 waiting for the worker · 3 of 3 slots in use · 2 not started · 1 waiting for approval · $4.12 spent
```

"Slots in use" stays — admission is a real constraint users hit — but it is no
longer the first number nor the only one, so it can no longer be read as "agents
running". The "waiting for the worker" clause is suppressed at zero, which is
the whole of the `maxParallelTasks = 1` case.

**Detail page** — one line under the existing badge row
(`src/app/(dashboard)/tasks/[id]/page.tsx:81-116`), from the same state; plus
the narrowed `live` computation at `:43` (§6.6).

**List API** — `src/app/api/tasks/route.ts:36`. See §9.

### 4.6 The presentation-layer boundary

`ExecutionState` never enters `PipelineContext`, never reaches
`nextTransition`, and never influences a transition. The state machine cannot
observe it and must not: a transition that depended on whether a job happened to
be claimed at that instant would be a race by construction. It is computed for
rendering, discarded after the response, and recomputed on the next one.

---

## 5. What the card shows

| State | Indicator | Title / `aria-label` | Card line |
|---|---|---|---|
| `in_flight`, `job: "agent"` | `PulseDot` (accent) | "An agent is running" | — |
| `in_flight`, `job: "delivery"` | `PulseDot` (accent) | "Pushing the branch and opening the change request" | — |
| `waiting_for_worker` | static dot (accent, no animation) | "Queued for the worker — 2nd of 3" | "2nd of 3 in the worker queue" |
| `retry_backoff` | static dot (warning) | "Stage failed; retrying" | "Retrying in 14s (attempt 2 of 3)" |
| `settling` | static dot (warning) | "Nothing is queued for this task" | "Admitted, but no job is queued — nothing will happen until it is started again" |
| `idle` | unchanged — existing `awaiting_gate` / `gate_queued` / `notStarted` branches at `task-board.tsx:60-91` | unchanged | unchanged |

`settling` gets warning tone rather than accent because, once the three reads
share a snapshot (§4.1), it is not a transient — it is a task the pipeline
stopped advancing. Calling it "starting the next stage", as an earlier draft of
this table did, would have been a fourth lie: the next stage is precisely what is
not starting.

**The pulse is the claim.** `PulseDot` (`src/components/pulse-dot.tsx:17-26`) is
the specific animation the README sentence is about. It stays for `in_flight`
and disappears everywhere else. A static dot in the same colour keeps the card's
visual weight: not a demotion of queued work, the removal of an assertion.

**Delivery keeps the pulse but loses the wording.** `DELIVERY` is a `deliver`
job (`orchestrator.ts:95`) that pushes a branch and calls a REST API
(`execute.ts:341-400`). The worker is genuinely working; no agent is running,
and saying one is would be a smaller version of the same lie.

**Motion is not the only signal.** `title` and `aria-label` carry the state in
words on every branch, as they already do at `task-board.tsx:75-90`. The
difference between a pulsing and a static dot is invisible under
`prefers-reduced-motion`, which `MotionProvider` honours by dropping the scale
animation (`pulse-dot.tsx:11-15`). The text is the accessible channel, required
rather than nice to have.

**Position wording:** `2nd of 3`, not `2/3` and not `position 2` — the ordinal
answers the question actually being asked. **Backoff countdown:** `retryAt`
minus now on the board's existing 4-second refresh, no per-card timer; backoffs
are 5 s and 20 s (`worker/index.ts:31`), so a stale value self-corrects within
one tick.

---

## 6. Latent bugs this change trips

### 6.1 `runningTaskCount()` counts workspace deletions as running agents

`src/server/jobs/queue.ts:61-68` filters on `eq(jobs.status, "claimed")` with no
`kind` filter. `cleanup_workspace` jobs are claimed like any other — the
candidate query in `claimNextJob` does not filter on `kind` either
(`queue.ts:88-96`), and the worker dispatches the kind only once it already
holds the job (`worker/index.ts:76-79`) — so a task whose workspace is being
deleted counts as a running task. It is `completed` and shows no pulse today,
which is why nobody has noticed — but the moment this function feeds a headline
"1 running" counter, a garbage-collection job inflates it.

**Fix, part of this change:** rename to
`inFlightTaskIds(): Map<string, JobKind>` — the callers here need the ids and
the kind, not a bare count — filtering `kind IN ('run_stage','deliver')`.

### 6.2 The retry-backoff window currently reads as "running"

On a retryable failure the worker calls
`failJob(job.id, message, Date.now() + backoff)` (`worker/index.ts:104`),
returning the job to `pending` with a future `runAfter` (`queue.ts:122-131`).
Nothing else changes: the retry branch (`worker/index.ts:96-106`) emits a
`log`/`warn` event and returns — it writes no `stage_failed` event and does not
touch `tasks`. So for up to 20 seconds (`worker/index.ts:31`) the task is
`running` and the card pulses while nothing is executing and nothing is eligible
to be claimed. The same defect as the headline one, smaller and older, fixed by
the same derivation.

**What the stage run reads during that window — corrected.** An earlier draft
claimed the stage run also stays `running`. Usually it does not: the failing
paths inside `execute.ts` mark it themselves before the error ever reaches the
worker (`:217` for an agent session, `:388` for delivery), so the common backoff
window shows a `failed` stage run under a pulsing card. It stays at `running`
only for failures that escape before the stage marks itself — workspace
preparation, the diff calls and `gatherInputs` (`execute.ts:146-190`), all of
which run after `markStageRunStatus(stageRunId, "running")` at `:132` and
outside the try at `:193-219`. That is the same class the worker's own comment
at `:118-122` calls out. Either way the card lies; only the timeline's
appearance differs, and neither variant is a reason to keep the pulse.

### 6.3 Three definitions of "active", none aware of the others

`ACTIVE_STATUSES` (`src/server/tasks/service.ts:319`) is `['running']` and feeds
all of admission control; `taskIsActive` (`queue.ts:162-170`) is
`queued | running | awaiting_gate` and is what the worker uses to skip jobs for
cancelled tasks (`worker/index.ts:132`, `:153`); `runningTaskCount`
(`queue.ts:61-68`) is claimed jobs. Each is right for its caller; all three are
*named* as though they answer the same question.

**This spec does not merge them** — merging would change admission-control
semantics for a naming benefit. It requires that each gain a docblock naming the
question it answers and pointing at the other two, and that `ExecutionState` be
the only one the UI ever reads.

### 6.4 `claimNextJob`'s cap counts cleanup jobs against `maxParallelTasks`

`busyTaskIds` (`queue.ts:79-86`) is built from every claimed job regardless of
kind, so with `maxParallelTasks = 1` a claimed `cleanup_workspace` blocks an
agent job for a different task in the same tick.

**Left as is, deliberately, and documented.** The worker is single-threaded, so
the block lasts exactly as long as the deletion, and loosening the cap would let
a cleanup and a stage run become concurrent the day the worker gains
parallelism — a real hazard, since a cleanup deletes a directory.

### 6.5 "N of M slots in use" becomes misleading once the cards disagree

`src/app/(dashboard)/page.tsx:112` renders `slots.active` from `capacity()`.
Today it is the only number on the page, so "3 of 3 slots in use" beside three
pulsing cards is internally consistent — consistently wrong, but consistent.
Once one card pulses and two do not, an unchanged header reads as a
contradiction and the user will believe the bigger number. The header rewrite in
§4.5 is therefore **not cosmetic and not optional**; it ships in the same change.

### 6.6 `LiveLog` claims a live stream for `gate_queued`

`src/app/(dashboard)/tasks/[id]/page.tsx:43` computes
`live = ["running","awaiting_gate","gate_queued"].includes(task.status)`, and
`LiveLog` renders "reconnecting" rather than "closed" when `live` is true and
the `EventSource` is down (`src/components/live-log.tsx:176-179`). A
`gate_queued` task has a recorded decision and no running stage; there is
nothing to reconnect to. Narrow `live` to `in_flight`, `waiting_for_worker`,
`retry_backoff` and `awaiting_gate` — the last because another tab can still
emit `gate_decided`.

---

## 7. Provider-locked copy: the full inventory

### 7.1 What the abstraction already offers

`RepositoryProvider` (`src/server/git/providers/types.ts:81-119`) has carried
`displayName` (`:83`) and `changeRequestNoun` (`:84-85`, commented "used
verbatim in the UI") since the multi-provider work. The noun is `"merge
request"` for GitLab (`gitlab.ts:54`) and `"pull request"` for the other four
(`github.ts:38`, `bitbucket.ts:44`, `azure-devops.ts:82`, `generic.ts:66`).
`providerFor(id)` (`providers/index.ts:28-30`) resolves a stored
`repos.provider` and falls back to `generic` rather than throwing, so it is safe
on every screen. The correct pattern is already written down, once:

```tsx
// src/app/(dashboard)/tasks/[id]/page.tsx:112-113
{/* "merge request" on GitLab — the provider owns the wording. */}
Open {providerFor(task.repo.provider).changeRequestNoun} ↗
```

`SetupNotice` does it too (`page.tsx:45`), with a comment at `:33-34` explaining
why it warns per connection rather than about `GITHUB_TOKEN`. The codebase knows
the rule; thirteen strings predate it or ignore it.

### 7.2 The inventory

| # | Location | Current | Replacement |
|---|---|---|---|
| 1 | `src/app/(dashboard)/page.tsx:135` | "…delivers the result as a pull request, so it needs a **GitHub** repository to work against." | No repo exists yet, so no provider does either. Enumerate from the registry: "…delivers the result as a change request. Connect a repository on {supportedProviderNames()} — or any git server, through the generic provider." |
| 2 | `src/app/(dashboard)/page.tsx:145` | "…build it, review it, and open a **pull request**." | Several repos may be connected: `changeRequestNounFor(connected providers)` — the shared noun if they agree, `"change request"` otherwise (§7.3). |
| 3 | `src/components/task-actions.tsx:38` | "Approving pushes the branch and opens a **pull request** — the merge still happens on **GitHub**." | "Approving pushes the branch and opens a {noun} — the merge still happens on {displayName}." |
| 4 | `src/app/(dashboard)/layout.tsx:15` | footer: "Merges always happen on **GitHub** — the pipeline only opens **pull requests**." | The layout has neither a task nor a repo in scope and must not acquire one for a footer. Provider-free: "Runs locally. The pipeline only ever opens change requests — merging stays with you." |
| 5 | `src/app/(dashboard)/tasks/new/page.tsx:22` | "…the agents read its code and deliver a **pull request** against it." | Zero-repo empty state; same treatment as #1. |
| 6 | `src/components/new-task-form.tsx:232` | hint: "Also used for the branch name and the **pull request** title." | `RepoOption` (`new-task-form.tsx:13`) gains `changeRequestNoun`; the hint interpolates the *selected* repo's noun and updates live when the select changes. |
| 7 | `src/components/live-log.tsx:93` | log line: `` `… pull request opened: ${event.url}` `` | The event payload carries only `url` (`src/server/events/store.ts:31`). Widen it to `{ type: "pr_opened"; url: string; noun?: string }`; `execute.ts:376` already has `change.noun` in hand (`pull-request.ts:109`). Rows written before the change have no `noun` and fall back to `"change request"`. |
| 8 | `src/app/(dashboard)/repos/page.tsx:44-46` | "**GitHub, GitLab, Bitbucket Cloud and Azure DevOps** are supported directly… leaves the **pull request** for you to open." | The page already maps `PROVIDERS` at `:30-37`. Build the sentence from that list and from `genericProvider.changeRequestNoun`. |
| 9 | `src/components/repo-manager.tsx:165` | `placeholder="https://github.com/acme/storefront"` | `selected.exampleUrl` — already used as the field's hint at `:158`, and `undefined` when no provider is chosen. A GitHub placeholder under a GitLab selection is a wrong answer, not a neutral one. |
| 10 | `src/worker/index.ts:55-57` | banner warning: "**GITHUB_TOKEN** is not set — cloning private repos and delivery will fail." | Per connection, mirroring `SetupNotice` (`page.tsx:35-48`): iterate `listRepos()`, resolve `credentialSource`, warn naming each missing variable and each provider's noun. Silent on a GitLab-only install, which is the point. |
| 11 | `src/app/api/settings/route.ts:20` | `githubTokenPresent: hasGithubToken()` | Already marked `@deprecated` in favour of `credentials` (`:18-19`), and nothing in `src/` reads it. Delete it with this change rather than carrying a provider-locked field for a release nobody is counting. |
| 12 | `src/components/repo-manager.tsx:223` | hint: "Only for credentials tied to an account name, such as a **Bitbucket** app password." | Provider-free, because no provider need be selected when this field is read: "Only for credentials tied to an account name rather than a bare token." This one is not optional — it is a display name in a JSX string literal outside `providers/`, so the §8 test fails on it whether or not it is listed. |
| 13 | `src/components/repo-manager.tsx:214` | `placeholder={selected?.defaultCredentialEnvVar ?? "GITHUB_TOKEN"}` | Drop the fallback, exactly as #9 drops the URL one: `selected?.defaultCredentialEnvVar` and no placeholder when nothing is selected. A GitHub variable suggested under a GitLab selection is a wrong answer; suggested under *no* selection it is a guess the form has no basis for. |

Two more, non-user-facing, included so the grep comes back clean:
`buildPullRequestBody` (`src/server/pipeline/execute.ts:311`, called at `:370`)
becomes `buildChangeRequestBody`, and `hasGithubToken`
(`src/server/config/env.ts:108-110`) loses its only two callers and goes with
them.

### 7.3 Which noun, when there is not exactly one provider

```ts
// src/lib/provider-copy.ts — new, and deliberately in src/lib, not src/server
export const NEUTRAL_CHANGE_REQUEST_NOUN = "change request";

/** The shared noun when every provider in scope agrees; the neutral term otherwise. */
export function changeRequestNounFor(nouns: readonly string[]): string {
  const distinct = new Set(nouns);
  return distinct.size === 1 ? [...distinct][0]! : NEUTRAL_CHANGE_REQUEST_NOUN;
}
```

`changeRequestNounFor` takes nouns, not providers, which is what lets it live in
`src/lib` — it never touches the registry. `supportedProviderNames()` (#1, #8)
does, so it is **not** in this module: it belongs beside the registry under
`src/server/git/providers`, and only server components call it. Putting it in
`src/lib/provider-copy.ts` would pull five provider implementations into the
browser bundle through the back door and quietly undo §7.4.

Three cases, exhaustively:

1. **One repository in scope** — task detail, gate panel, review page, the
   new-task form once a repo is picked. That provider's noun. The common case,
   and the one that matters most: it is where the user is looking at a specific
   change request.
2. **Several repositories, possibly different providers** — dashboard copy.
   `changeRequestNounFor` collapses them when they agree, which on a
   single-provider install is always.
3. **No repository at all** — first-run empty states, the footer. The neutral
   term, plus the supported-provider list derived from `PROVIDERS` where naming
   hosts actually helps (#1, #5, #8).

**Why `"change request"` as the neutral term.** It is already the codebase's own
vocabulary — `changeRequestNoun`, `ChangeRequestInput`, `ChangeRequestRef`,
`createChangeRequest`, `ChangeRequestResult` (`types.ts:72-79`,
`pull-request.ts:14-16`). One vocabulary instead of two. The alternative — fall
back to `"pull request"` because four of five providers use it — is right four
times in five and wrong for the exact user this exercise is about.

### 7.4 Client components never import the registry

`task-actions.tsx`, `new-task-form.tsx`, `repo-manager.tsx` and
`task-board.tsx` are all `"use client"`. They receive `changeRequestNoun` and
`providerDisplayName` as **props** from their server parent, which already has
the repo in scope in every case (`tasks/[id]/page.tsx:130`, `review/page.tsx:40`,
`tasks/new/page.tsx:34`, `repos/page.tsx:49`).

Two reasons, either sufficient. Importing `@/server/git/providers` into a client
component pulls five provider implementations and their HTTP clients into the
browser bundle. And a prop is a compile-time obligation: `GATE_COPY`
(`task-actions.tsx:17-42`) stops being a static `Record<Gate, …>` and becomes
`gateCopy(gate, { displayName, changeRequestNoun })`, so a caller with no
provider in scope fails to typecheck instead of quietly rendering "GitHub".

### 7.5 The two marketing claims

**`site/src/lib/content.ts:25`** — "staffed entirely by **Claude** agents".
False since per-role backends landed: `LLM_PROVIDER_IDS` is
`["claude","chatgpt","gemini"]` (`src/server/config/llm-providers.ts:10`),
selectable per agent stage in Settings (`settings-form.tsx:105-141`).
Replacement: "…staffed by LLM agents — Claude by default, with ChatGPT and
Gemini selectable per role."

**`site/src/lib/content.ts:207` and `README.md:73-76`** — the "means exactly
that" claim. Not deleted; narrowed to what admission control guarantees plus
what §4 makes true:

> Nothing starts on its own. A new task sits in the Created column until you
> start it, and at most `MAX_PARALLEL_TASKS` tasks are ever admitted. Above one,
> the worker still runs one stage at a time — so a card only pulses while the
> worker is executing that task's stage, and every other admitted task says
> where it is in the queue.

Longer than the sentence it replaces, true, and the second property is more
interesting than the one being given up.

---

## 8. The rule that stops the regression

> **No provider display name, no change-request noun and no provider-specific
> credential variable name may appear as a literal string anywhere under `src/`,
> outside `src/server/git/providers/`.**

Four clarifications make it enforceable:

- **The provider modules are the exception because they are the abstraction.**
  `github.ts:37-38` is where `"GitHub"` and `"pull request"` belong. Nothing
  else in `src/` needs a literal, because `providerFor` reaches all of them.
- **Lowercase `ProviderId` values are data, not copy.** `"github"` at
  `schema.ts:30`, `service.ts:61` and `bootstrap.sql.ts:17` is a key. The ban is
  on *display* forms — `GitHub`, `GitLab`, `Bitbucket`, `Azure DevOps` — matched
  case-sensitively, plus `pull request` / `merge request` matched
  case-insensitively. The id is legal by construction: branding is banned, keys
  are not.
- **Conventional variable names are a third form, and a display-name scan misses
  them.** A case-sensitive `GitHub` does not match `GITHUB_TOKEN`, which is how
  #13 survived a grep for branding. Extend the banned set with the four literals
  behind `defaultCredentialEnvVar` (`github.ts:42`, `gitlab.ts:57`,
  `bitbucket.ts:50`, `azure-devops.ts:84`). Once #10 and #13 land and
  `hasGithubToken` goes with them (`env.ts:108-110`), the only occurrence left
  outside `providers/` is the format example in `validateCredentialRef`
  (`credentials.ts:50` — "…for example BITBUCKET_TOKEN_ACME"). That is the
  allowlist's first and, for now, only entry: an example of a *shape* has to name
  something, and it asserts nothing about the user's provider.
- **Comments are exempt.** Half the current matches are explanations —
  `bitbucket.ts:1`, `gitlab.ts:19`, `credentials.ts:82`,
  `tasks/[id]/page.tsx:112`. A rule that forbids explaining GitLab's noun in a
  comment about GitLab's noun makes the code worse.

**How a reviewer spots a violation.** Any new user-visible string that names a
host or a kind of change request. If the component has no provider in scope,
*that* is the defect — thread the repo through from the server parent, or write
copy that names no provider (§7.3 case 3). "There was nowhere to get it from" is
the exact reasoning that produced all thirteen existing occurrences.

**How CI spots it.** `tests/provider-copy.test.ts`, modelled on
`tests/diff-viewer-safety.test.ts:15-25` — which already reads a file, strips
comments and asserts a substring is absent. It walks `src/**/*.{ts,tsx}`, skips
`src/server/git/providers/`, strips block and line comments, and asserts none of
the banned forms appears in a string literal, template literal or JSX text node.

A regex over literals rather than an AST walk, deliberately: the AST version is
exact and roughly ten times the code, and a check nobody can read is a check
someone deletes the first time it is wrong. The regex version carries a short
commented allowlist for the cases it cannot distinguish; an allowlist that grows
is itself the signal.

**`site/` is governed differently, not exempted.** It is a marketing page whose
job includes naming what the product integrates with, and it already has a typed
`PROVIDERS` table (`site/src/lib/content.ts:216-224` for the type and the
declaration) with `name` and `requestName` per provider. The rule there: **a
provider may be named in an enumeration, never as the only option.**
`content.ts:25`'s "on GitHub, GitLab, Bitbucket or Azure
DevOps" passes; its "staffed entirely by Claude agents" fails, because there is
no enumeration and there are three backends.

---

## 9. API

`ExecutionState` joins the two task payloads. No new endpoint.

```jsonc
// GET /api/tasks
{
  "tasks": [
    { "id": "task_a", "status": "running",       "currentStage": "DEVELOPMENT",
      "execution": { "kind": "in_flight", "job": "agent" } },
    { "id": "task_b", "status": "running",       "currentStage": "ARCHITECTURE",
      "execution": { "kind": "waiting_for_worker", "position": 1, "depth": 2 } },
    { "id": "task_c", "status": "running",       "currentStage": "QA",
      "execution": { "kind": "retry_backoff", "retryAt": 1754400000000, "attempt": 2 } },
    { "id": "task_d", "status": "awaiting_gate", "currentStage": "PLAN_GATE",
      "execution": { "kind": "idle" } }
  ],
  "capacity": { "limit": 3, "active": 3, "slotAvailable": false, "blocking": [ /* … */ ] },
  "worker":   { "inFlight": 1, "waiting": 2, "backoff": 1 }
}
```

**`capacity` keeps its exact current shape and meaning**
(`orchestrator.ts:187-201`); `worker` sits beside it. Merging them would
recreate in the API the conflation this spec removes from the UI — `capacity`
answers "can I start another task", `worker` answers "what is happening right
now". Different questions, different consumers, adjacent keys.

`GET /api/tasks/:id` (`src/app/api/tasks/[id]/route.ts:33-54`) gains the same
`execution` key at the top level, next to `costUsd`. Both changes are additive;
no existing field changes type or meaning.

---

## 10. Test plan

**Derivation (pure, no DB)**
- Every `(task status, job rows)` combination maps to the documented
  `ExecutionState`, parameterised — with `settling` (admitted, no claimed job and
  no eligible pending one) asserted explicitly rather than falling through to
  `idle`. The fixture for it
  is a `running` task whose only job is `failed`, which is what
  `worker/index.ts:139-141` leaves behind — *not* a "between stages" fixture,
  which the pipeline never produces (§4.1).
- A task with both a claimed job and a pending one — the ordinary window between
  `advanceTask` and `completeJob` — is `in_flight`, and contributes nothing to
  any other task's `position` or `depth`.
- A claimed `cleanup_workspace` job for a terminal task yields `idle` and does
  **not** appear in `inFlightTaskIds()` — the §6.1 regression.
- A pending job with `runAfter > now` yields `retry_backoff`, not
  `waiting_for_worker`, and is excluded from every other task's `depth`.
- Positions over a mixed queue are `1..depth`, contiguous and unique.

**Queue ordering (DB)**
- The task at `position: 1` is the one `claimNextJob` actually returns next,
  **given a fixture of `run_stage`/`deliver` jobs only and no task already
  holding a claimed job.** Both qualifiers are load-bearing and both are §4.4's:
  an eligible `cleanup_workspace` job can be claimed ahead of position 1, and a
  busy task's job is skipped by `queue.ts:98`. Stating the test without them
  makes it false against the current worker. Parameterised over priority
  (`urgent`…`low`), difficulty (`S`/`M`/`L`/`NULL`) and insertion order. This is
  what keeps the shared ranking honest, and the reason the SQL fragments are
  exported rather than retyped.
- A separate test for each qualifier, since each is a real behaviour rather than
  a caveat: an eligible cleanup job for an `urgent` completed task is claimed
  before the `low` task shown at "1st of 1", and neither appears in `depth`.
- The JS ranking (`orchestrator.ts:261-286`) and the SQL ranking
  (`queue.ts:22-26`) produce the same **priority/difficulty rank** for the same
  fixture. Not the same total order: the SQL breaks ties on `jobs.run_after` then
  `jobs.created_at` (`queue.ts:93`) while `promoteQueue` breaks them on
  `tasks.updatedAt` (`orchestrator.ts:330`). The fixture must therefore either
  avoid ties or assert only the rank, or the test fails on a correct
  implementation.

**API**
- `GET /api/tasks` returns `execution` per task and a `worker` block whose
  `inFlight` equals the number of claimed stage jobs; `capacity` is unchanged
  against the pre-change fixture.
- `GET /api/tasks/:id` carries `execution` for a task with a claimed job, with a
  pending job, and with no job.

**Copy (source scan)**
- `tests/provider-copy.test.ts` fails on a fixture with `"GitHub"` in a string
  literal under `src/components/`, and passes on the same word in a comment and
  in `src/server/git/providers/github.ts`.
- Parameterised over each banned form, including `"Merge Request"` and
  `"pull requests"` (plural), which a naive exact-match check misses, and the
  four `*_TOKEN` literals, which the display-name pattern does not match at all
  (§8).
- Run against the real `src/` tree it must come back clean only after all
  thirteen replacements land. A green run against the eleven this spec first
  listed would mean the inventory was short, not that the tree was clean —
  `repo-manager.tsx:223` alone fails it.
- `changeRequestNounFor` returns the shared noun for two matching providers and
  `"change request"` for a mixed pair and for `[]`.

**Component**
- One card parameterised over all five states: a `PulseDot` appears for
  `in_flight` and for nothing else.
- A `waiting_for_worker` card renders its ordinal and does not render "An agent
  is running" anywhere, `title` and `aria-label` included.
- `GatePanel` for `STAKEHOLDER_GATE` handed GitLab's provider strings renders
  "merge request" and "GitLab", and neither "GitHub" nor "pull request" appears
  — the regression test for `task-actions.tsx:38`.
- `gateCopy` does not compile without provider strings: a type-level assertion,
  since that is the mechanism §7.4 relies on.

**Integration**
- Three tasks admitted with `maxParallelTasks = 3`, one job claimed: exactly one
  pulse, two ordinals, and a header reading "1 running · 2 waiting for the
  worker · 3 of 3 slots in use".
- The head of the queue becomes `in_flight` and the rest shift down by one when
  the claimed job completes and the next is claimed.
- A retryable stage failure moves its task from `in_flight` to `retry_backoff`
  and back to `waiting_for_worker` once `runAfter` passes.

---

## 11. Phasing

**Phase A — the derivation and the board.** `src/server/pipeline/execution.ts`,
the `inFlightTaskIds()` fix (§6.1), the exported ranking fragments, the five card
states (§5) and the header rewrite (§6.5). The whole of Problem 1 on the surface
where the claim is loudest and where the README points. The largest phase and the
only one with a real design in it; everything after is application.

**Phase B — the other two surfaces and the API.** The detail page line, the
narrowed `live` computation (§6.6), and `execution` / `worker` in both task
payloads (§9). Independently valuable: the API is what a second client or the
user's own `curl` reads, and it offers no way at all today to tell admitted from
running.

**Phase C — provider copy.** The thirteen replacements (§7.2), the
`provider-copy.ts` helper, the `gateCopy` signature change and the source-scan
test (§8). **Entirely independent of A and B** — it shares no code and could ship
first. Sequenced last only because the pulsing-dot lie is the more damaging of
the two: it misleads a user about what their money is doing, where the provider
copy misleads them about a noun.

**Phase D — the marketing claims.** `README.md:73-76`,
`site/src/lib/content.ts:25` and `:207` (§7.5). Deliberately last: rewriting the
README to describe behaviour that has not shipped would be a third lie, told in
the other direction.

---

## 12. Open questions

1. **Should `waiting_for_worker` show a position at all?** It is accurate at
   render and up to four seconds stale by the next `AutoRefresh` tick
   (`auto-refresh.tsx:12`), and on a mixed-priority board a newly started urgent
   task pushes an existing card from 1st to 2nd, which reads as the system going
   backwards. Resolved here in favour of showing it, because the ordinal answers
   the question actually being asked. A `depth`-only variant ("queued behind 2
   tasks") is a one-line change if the flicker turns out worse than the
   ambiguity.

2. **Should `maxParallelTasks` above 1 be offered at all?** With one worker its
   honest meaning is "how many tasks may be admitted", not "how many run at
   once", and admitting more than one buys nothing but a queue. Three options:
   cap the input at 1 until the worker runs concurrent jobs; relabel the field
   "Tasks admitted at once" and keep the range; or leave it. This spec assumes
   the third — making the queue visible is the cheapest and forecloses neither
   other. A decision is genuinely needed: under option one, most of §4.4 is dead
   code.

3. **Is `"change request"` the right neutral noun?** It is the codebase's term
   (`changeRequestNoun`, `types.ts:85`) and nobody says it out loud. "Pull
   request" as the majority fallback is more natural for four users in five and
   wrong for the fifth. A
   third option — the noun of the most recently connected repository — is worse
   than both: silently wrong, and changing in response to an unrelated action.

4. **Should `site/`'s provider table be generated from
   `src/server/git/providers`?** `site/src/lib/content.ts:1-5` says in its own
   docblock that keeping the copy in one typed module is "what stops the
   marketing text and the documentation from drifting apart" — and then
   hardcodes a second provider list. But `site/` is a separate app with its own
   build and lint config (`eslint.config.mjs` ignores `site/**`), so sharing a
   module means a build dependency between them. Trade: one list, versus two
   that are already drifting on the LLM-backend claim.

5. **Renaming the `pr_opened` event.** The string is persisted in `events.type`
   (`schema.ts:179`) and appears in `REFRESH_TRIGGERS` (`live-log.tsx:28`) and
   the SSE listener list (`:140`). Renaming to `change_request_opened` needs
   either a migration rewriting historical rows or a permanent alias in the
   reader. Neither is expensive; the question is whether an audit log should ever
   be rewritten, which `spec-audit-trail.md` is better placed to answer.
