# Spend and Operational Control — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Close the "start it and walk away" loop: make the configured quota
> an admission decision instead of a read-out, give a task a spend ceiling that
> can actually stop it, make Cancel stop the spend it claims to stop, prove the
> worker is alive, and tell the user when a gate opens.
> **Prerequisite:** the pipeline as built. `spec-execution-honesty.md` should
> land first — this spec adds the worker heartbeat, that one owns what the card
> is allowed to claim, and the two meet on the same board.
> **Related:** `spec-cost-forecast.md` (§9 proposed budget caps and was never
> built; §4.3 is the rework variable this spec bounds);
> `spec-task-queue.md` (§8.2 the admission invariant §2 extends, §8.5 the
> promotion loop §2.4 reuses); `spec-retry-recovery.md` (§6 — a granted rework
> cycle is new spend and must pass the same admission check);
> `spec-cost-observability.md` (§4 — per-provider quota; this spec assumes the
> single-pool model and says where it breaks);
> `spec-audit-trail.md` (§7 — the abort event and the partial cost record).

---

## 1. Summary

The product's thesis is one sentence: *write the task, walk away, trust what
comes back.* Three things have to be true for that to hold. None of them are.

**Nothing stops you spending.** `resolveQuotaStatus` (`quota.ts:82-103`) has
exactly one production caller — the dashboard render at
`src/app/(dashboard)/page.tsx:95`, feeding a bar at `:156`. `startTask`
(`orchestrator.ts:245-253`) checks prerequisites and a concurrency slot and
nothing else. A user who types a $10 limit into Settings and queues twelve tasks
wakes up with twelve tasks started and the bar coloured red. The limit is a
gauge, not a valve.

**Nothing stops a task.** The only ceiling on one stage is `maxTurns`, and
eighty turns of Opus is not eighty turns of Haiku. The installed Claude Agent
SDK already accepts a dollar ceiling — `maxBudgetUsd?: number` at
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1683` — and `buildOptions`
(`claude.ts:28-49`) does not pass it.

**Cancel does not cancel.** `RunStageOptions.abortController`
(`providers/types.ts:37`) is forwarded to the Claude SDK (`claude.ts:40`) and
to the OpenAI request (`openai.ts:98`), and **nothing in `src/` ever constructs
one**. Cancelling a task marks rows and drops *pending* jobs
(`cancelPendingJobs`, `queue.ts:134-139`); the DEVELOPMENT session already
running on turn 40 of 80 keeps going, because `worker/index.ts:163` is awaiting
it with no way to interrupt. Gemini has no abort plumbing at all: its client
type (`gemini.ts:30-46`) has no signal parameter and `options.abortController`
appears nowhere in the file.

And underneath all three: **nothing proves the worker is alive.** If it dies,
tasks sit at `running` with the dot pulsing forever, and the operator cannot
tell "the Developer is thinking" from "nothing has run for two hours."

This spec covers six changes, ordered by what a user loses without them:

| § | Change | What it prevents |
|---|---|---|
| 2 | Quota as admission control | Waking up to a spent month |
| 3 | Per-task budget ceiling | One runaway task spending the month |
| 4 | Cancel that aborts the session | Paying for work you already stopped |
| 5 | Worker heartbeat | Not knowing the system is dead |
| 6 | Notifications | A gate sitting unopened overnight |
| 7 | Hold and pause | Cancel-or-nothing as the only brake |

---

## 2. Scope

**In scope**

- A quota check inside the admission transaction, with modes (§2.2) and an
  explicit override (§2.5).
- A per-task spend ceiling enforced by every provider (§3), including the
  partial-cost accounting that makes it honest (§3.4).
- A real `AbortController` per job, wired to all three providers (§4).
- A worker heartbeat row, a health endpoint and a nav indicator (§5).
- An outbound notification dispatcher on top of `appendEvent` (§6).
- A global queue hold and a per-task "pause after this stage" (§7).

**Out of scope**

- Per-provider quota pools. This spec keeps the current single-pool model and
  documents exactly where it lies (§2.6); `spec-cost-observability.md` §4 owns
  the fix, and it depends on the `model`/`provider` columns that spec adds.
- Forecasting what a task *will* cost. `spec-cost-forecast.md` owns it, and
  §3.6 argues it belongs after this spec, not before.
- Making the "running" badge honest about which task the worker holds.
  `spec-execution-honesty.md` §3 owns that; this spec only supplies the
  heartbeat it reads (§5.4).
- Running more than one job concurrently. §5.5 explains why this spec makes
  that *safer* to add later, and why it should still not be added yet.
- Email or SMS notification transports. §6.3 ships browser and webhook only,
  and says why a webhook plus ntfy/Slack covers the rest at no maintenance cost.

---

## 3. What already exists, and what is missing

Naming what is already built matters here, because four of the six changes are
wiring rather than construction.

| Capability | Status |
|---|---|
| Quota arithmetic, cadence, period boundaries, warning threshold | Built — `quota.ts:28-103` |
| Parking an inadmissible task at `on_queue` and re-trying it later | Built — `orchestrator.ts:405-429`, `promoteQueue` at `:328-355` |
| Cost per stage run, and `costSince(ms)` | Built — `service.ts:602-611` |
| A dollar ceiling in the Claude SDK | Built upstream, unused — `sdk.d.ts:1683` |
| Abort plumbing for Claude and OpenAI | Built, never invoked — `claude.ts:40`, `openai.ts:98` |
| Abort plumbing for Gemini | **Missing** |
| A single event funnel every notable transition passes through | Built — `appendEvent`, `events/store.ts:50` |
| Any signal that the worker process exists | **Missing** |
| Any way to stop work without a terminal `CANCELLED` | **Missing** |

---

## 4. Quota as admission control

### 4.1 Why the current placement cannot work

`resolveQuotaStatus` reads the clock, the settings and `costSince`, and returns
a state. It is called during a React server render. Two things follow: it can
only ever *describe*, and it describes a moment that has already passed by the
time the user clicks Start.

The fix is not to call it from the route handler either. `spec-task-queue.md`
§8.2 established the rule that admission checks must run inside the same
transaction as the transition they guard, precisely because two requests can
otherwise both observe a free slot. Quota is the same shape of check with the
same race, and it must live in the same place: inside `startTask`'s
transaction, beside `assertSlotAvailable`.

### 4.2 Three modes, not a boolean

A hard limit is wrong as the only option, because the number is user-entered
and the product cannot verify it against a real bill (`quota.ts:9-14` is honest
about this). A limit that is a guess must not become an outage.

```ts
export type QuotaEnforcement = "off" | "warn" | "hold";
```

- **`off`** — today's behaviour. The bar renders; nothing is refused. This stays
  the default for existing installations (§4.7).
- **`warn`** — the start proceeds, and a `quota_warning` event is appended so the
  live log and the notification dispatcher (§6) both see it.
- **`hold`** — the start is refused and the task parks at `on_queue`, exactly as
  a capacity refusal does today.

`warn` exists because the first useful thing a limit does is tell you it was
crossed. Forcing users to choose between "no signal" and "blocked" would push
most of them to `off`.

### 4.3 The refusal

A new error, parallel to `CapacityError` (`orchestrator.ts:159-171`) and
carrying what the UI needs to explain itself rather than just refuse:

```ts
export class QuotaError extends Error {
  constructor(
    readonly limitUsd: number,
    readonly usedUsd: number,
    readonly cadence: Cadence,
    readonly resetAt: number,
  ) {
    super(
      `Spend limit of ${formatCost(limitUsd)} per ${cadence === "daily" ? "day" : "hour"} ` +
        `reached (${formatCost(usedUsd)} used); resets ${formatDateTime(resetAt)}.`,
    );
    this.name = "QuotaError";
  }
}
```

`assertWithinQuota()` sits beside `assertSlotAvailable()` and is called from
`startTask`, `resumeGatedTask` and `retryTask` — every path that admits work.
Order matters and is deliberate:

1. `assertPrerequisitesMet` — a hard, unconditional gate (`orchestrator.ts:228-231`).
2. `assertWithinQuota` — refuses on money, which no amount of waiting for a slot
   will fix.
3. `assertSlotAvailable` — refuses on concurrency.

Quota before capacity, because the two produce different messages and the money
one is the more actionable of the two. A user told "no slot free" will wait; a
user told "you are at your limit" will either raise it or stop.

### 4.4 Parking, not failing

`promoteQueue` (`orchestrator.ts:328-355`) already loops over `on_queue` and
`gate_queued` candidates, catching the expected per-candidate races and moving
on. `QuotaError` joins that list — with one difference from `DependencyError`.

A dependency can be satisfied by the very next transition, so skipping to the
next candidate is right. A quota refusal will refuse *every* candidate in the
same instant, exactly like `CapacityError`. So `QuotaError` **stops the loop**:

```ts
if (error instanceof CapacityError || error instanceof QuotaError) return;
```

Without that, one promotion attempt runs `costSince` once per queued task for a
queue that cannot move.

### 4.5 What re-checks a parked task

Nothing today wakes the queue on a clock. `promoteQueue` runs after a
slot-freeing transition (`advanceTask`, `orchestrator.ts:147-149`), and a quota
period boundary is not a transition. A task parked on quota at 23:50 would sit
there until an unrelated task finished.

Two options were considered:

- **A periodic tick in the worker.** The worker already loops every second
  (`worker/index.ts:181-190`). Calling `promoteQueue` on a slow sub-tick (once a
  minute) costs one query and closes the gap.
- **Scheduling a wake-up job at `nextReset`.** `nextReset` already computes the
  boundary (`quota.ts:39-47`) and the job queue already supports `runAfter`
  (`queue.ts:40-58`), which is how workspace cleanup is deferred.

**Take the second.** It is precise, needs no new loop, and reuses the deferral
mechanism that already exists. One `quota_wake` job is enqueued when the first
task parks on quota, and it is not re-enqueued while one is pending.

### 4.6 The override

A refusal the user cannot overrule is wrong for a single-user local tool where
the limit is self-imposed. The Start action on a quota-held task offers **"Start
anyway"**, which passes `overrideQuota: true` through the API to `startTask` and
skips only `assertWithinQuota`. Capacity and dependencies are not overridable —
those protect invariants, not the user's wallet.

Every override appends an event, so `/usage` can later answer "how often did I
overrule myself".

### 4.7 Compatibility

`quotaLimits` already defaults to `{ limitUsd: null }` per mode
(`env.ts:180-191`), and a null limit yields `state: "not_configured"`
(`quota.ts:87`). Adding `enforcement: "off"` to the settings blob means every
existing installation behaves exactly as it does today until the user changes
it. This is the same merge-with-defaults path that `providers` used when
multi-LLM landed (`settings/store.ts:118-120`), and it needs no migration.

### 4.8 Where the single pool lies

`costSince` (`service.ts:602-611`) sums `stage_runs.cost_usd` across every task
regardless of which provider produced it, while the quota key is the **Claude**
auth mode (`quota.ts:83-87`). So Gemini spend is debited against a Claude
subscription, and an installation with no Claude credential shows
"not configured" while ChatGPT spends real money.

This spec does **not** fix that, because segmenting spend by provider requires a
`provider` column on `stage_runs` that does not exist yet
(`spec-cost-observability.md` §3). What it does is refuse to make it worse: the
enforcement UI names the pool it is enforcing ("all providers, combined") rather
than implying a per-provider guarantee it cannot deliver.

---

## 5. Per-task spend ceiling

### 5.1 Why `maxTurns` is not a budget

`maxTurns` is per stage and defaults to a total of 218 turns across the seven
agent stages (`settings/store.ts:82-92`). It bounds *iterations*, and the cost of
an iteration varies by a factor of roughly thirty across the model tiers a user
can select per role (`settings-form.tsx`, model field per stage). A turn ceiling
tuned for Haiku is not a ceiling at all for Opus.

### 5.2 Where the ceiling lives

Two levels, because they answer different questions:

- **`maxCostPerStageUsd`** — a setting, applied to every stage run. Answers
  "no single agent session should ever exceed this."
- **`maxCostPerTaskUsd`** — a per-task field with a settings default. Answers
  "this whole task is not worth more than this", which is the number a user
  actually has in their head when they write the task.

The per-task ceiling is checked **before scheduling each stage** — in
`scheduleStage` (`orchestrator.ts:87-98`), which is the single funnel every
stage run passes through — by comparing `totalCostForTask(taskId)`
(`service.ts:587-594`) against the ceiling. Exceeding it is a terminal failure
with a reason that names the number, not a silent stop.

### 5.3 Enforcing it inside a running stage

The per-stage ceiling is enforced by the provider, and each of the three needs
different work:

**Claude.** Pass it. `buildOptions` (`claude.ts:28-49`) gains one line:

```ts
maxBudgetUsd: options.maxCostUsd,
```

The SDK declares it at `sdk.d.ts:1683`. When the session stops for budget, it
ends with a non-`success` subtype and the existing handler at `claude.ts:118-126`
already raises a `StageExecutionError` carrying `costUsd` and the transcript.
The only change needed there is a message that distinguishes budget from
`error_max_turns`.

**OpenAI.** The manual loop at `openai.ts:91-158` already accumulates
`inputTokens`/`outputTokens` per turn (`:102-103`). Add a cost check at the top
of each iteration, computed with the existing `estimateCostUsd`
(`providers/pricing.ts`, already imported at `openai.ts:5`), and break with a
`StageExecutionError` carrying the partial.

**Gemini.** Same shape — the loop at `gemini.ts:96-164` accumulates tokens at
`:106-107` and already calls `estimateCostUsd` at `:166`. Move that call inside
the loop.

The check is necessarily *after* the turn that crossed the line, not before: no
provider reports what a turn will cost. The ceiling is therefore a stop-loss,
not a hard cap, and §5.7 requires the UI to say so.

### 5.4 The partial-cost bug this depends on

A budget stop is worthless if the spend it stopped is not recorded, and today it
would not be. `StageExecutionError` carries a `partial: Partial<StageExecutionResult>`
(`providers/types.ts:42-50`), populated by every provider at every throw site.
`executeAgentStage` throws it away:

```ts
// src/server/pipeline/execute.ts:215-219
} catch (error) {
  const message = redactRemote(error instanceof Error ? error.message : String(error));
  markStageRunStatus(stageRunId, "failed", { error: message });
  throw new StageJobError(message);
}
```

`markStageRunStatus` writes the status and the error; `inputTokens`,
`outputTokens` and `costUsd` are never touched, so the run records **$0** for a
session that may have burned five dollars before failing. That is already wrong
today for every `error_max_turns` and every mid-session crash. It becomes
absurd once a budget stop is the *intended* path.

The fix is to read the partial before rethrowing:

```ts
} catch (error) {
  const partial = error instanceof StageExecutionError ? error.partial : {};
  const message = redactRemote(error instanceof Error ? error.message : String(error));
  markStageRunStatus(stageRunId, "failed", {
    error: message,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    costUsd: partial.costUsd ?? 0,
  });
  throw new StageJobError(message, /* retryable */ !isBudgetStop(error));
}
```

Note the second argument: a budget stop is **not retryable**. The worker's
retry policy (`worker/index.ts:94-106`) would otherwise re-run the session
twice more, each time spending up to the ceiling again — turning a $5 cap into
$15.

This change alone is worth landing before the rest of §5; it makes `/usage`
honest about failed runs, which it is not today.

### 5.5 What a budget stop does to the task

Terminal `FAILED`, with a reason naming the ceiling and the spend. Not a rework
cycle: the Developer did not produce bad code, it ran out of money, and sending
it back to try again is how a ceiling becomes a floor.

The task keeps its workspace and branch until the retention job, so
`spec-retry-recovery.md`'s retry path applies — and per §6 of that spec, a retry
of a budget-stopped task must be offered *with* a raised ceiling, otherwise it
stops at exactly the same point.

### 5.6 Why this comes before forecasting

`spec-cost-forecast.md` is a complete, unbuilt 450-line design for predicting
what a task will cost. It should stay unbuilt until this section lands.

A forecast without a control is decoration. The user's fear is not "what will
this cost" — it is "what can this cost while I am not watching". A ceiling
answers that question exactly, in far less code, and it makes the forecast more
useful when it arrives, because a forecast can then be expressed as a
*suggested ceiling* rather than a number to worry about.

### 5.7 What the UI must not imply

The ceiling is enforced after the turn that crossed it, and the Claude figure is
the SDK's own `total_cost_usd`, which in subscription mode is an estimate of
equivalent API spend rather than a bill (`README.md` "Known limits"). The
Settings copy says both, in the same sentence as the field. A cap presented as
exact would be a second promise the product cannot keep, which is the class of
defect this whole spec set exists to remove.

---

## 6. Cancel that stops the spend

### 6.1 What Cancel does today

`cancelTask` (`orchestrator.ts:767-774`) appends a log event and calls
`advanceTask` with `{ kind: "cancel" }`, which produces a terminal `CANCELLED`
and cancels *pending* jobs (`applyTransition`'s terminal branch,
`orchestrator.ts:115-125`, calling `cancelPendingJobs`, `queue.ts:134-139`).

The job that is currently claimed and executing is not affected. The worker is
inside `await handleJob(job)` (`worker/index.ts:163`), which is inside
`executeAgentStage`, which is inside a provider's `for await` or `while` loop.
Nothing observes the cancellation until that returns. On a DEVELOPMENT stage
with `maxTurns: 80`, that can be many minutes and many dollars after the user
pressed a button labelled Cancel.

### 6.2 A controller per job

The worker owns one controller for the lifetime of one job:

```ts
// src/worker/index.ts
let activeJob: JobRow | null = null;
let activeAbort: AbortController | null = null;

async function tick(): Promise<void> {
  // …
  activeJob = job;
  activeAbort = new AbortController();
  try {
    await handleJob(job, activeAbort);
  } finally {
    activeJob = null;
    activeAbort = null;
  }
}
```

The controller threads through `handleJob` → `executeAgentStage` →
`runStage(provider, options)` into the `RunStageOptions.abortController` field
that already exists and is already forwarded.

### 6.3 How the worker learns about the cancellation

The web process and the worker are separate OS processes sharing a SQLite file.
There is no channel between them other than that file — which is exactly the
constraint the event log was designed around (`events/store.ts:8-13`).

So the worker polls. Its loop already runs every second (`TICK_MS`,
`worker/index.ts:28`); while a job is in flight the loop is blocked inside
`await handleJob`, so the poll needs its own timer started alongside the
controller:

```ts
const watch = setInterval(() => {
  if (!taskIsActive(job.taskId)) activeAbort?.abort();
}, CANCEL_POLL_MS);
```

`taskIsActive` (`queue.ts:162-170`) already returns `false` for every terminal
status, so cancellation, rejection and failure all trip it with no new query.
The interval is cleared in the same `finally` that clears the controller.

`CANCEL_POLL_MS` of 2000 is proposed: the cost is one indexed single-row read
per two seconds per in-flight job, against a saving measured in agent turns.

### 6.4 Gemini needs the plumbing built

Claude and OpenAI accept the signal today. Gemini does not: the client type at
`gemini.ts:30-46` declares `generateContent(params)` with `model`, `contents`
and `config` and no abort parameter, and `options.abortController` is not
referenced anywhere in the file.

`@google/genai` accepts an `abortSignal` in its request config. The narrow
client type in this file exists so tests can inject a fake (`gemini.ts:28-29`),
so the change is: widen the type, pass the signal, and — because the SDK's
cancellation granularity is per request, not per loop — also check
`signal.aborted` at the top of each `while` iteration so a cancellation between
turns stops before spending another one.

That between-turns check is worth adding to OpenAI too (`openai.ts:91`), for the
same reason: an in-flight HTTP request is aborted by the signal, but the loop
would otherwise start the next turn.

### 6.5 An aborted stage is not a failure

An abort must not be reported as a crash. `StageExecutionError` gains a
discriminator, or a subclass `StageAbortedError`, so that:

- the stage run is marked `cancelled` rather than `failed` — note that
  `STAGE_RUN_STATUSES` (`stages.ts:161-168`) has no such member today, and
  §6.6 decides what to do about that;
- the partial cost is recorded via the §5.4 fix, because the user should see
  what the cancelled run cost;
- the worker's retry policy does not re-run it — `handleJobFailure`
  (`worker/index.ts:84-143`) currently retries anything without
  `retryable === false`, and a cancelled job retried twice is the same absurdity
  as a budget stop retried twice;
- `advanceTask` is **not** called, because `cancelTask` already drove the task
  to `CANCELLED` before the abort fired.

### 6.6 The `rejected` status slot

`STAGE_RUN_STATUSES` includes `"rejected"` and nothing in `src/` ever writes it
(the same dead slot `spec-retry-recovery.md` §4 claims for terminal-cause
recording). This spec does **not** also claim it. Two features quietly writing
different meanings into one unused enum member is how a schema becomes
unreadable.

`"cancelled"` is added as a new `StageRunStatus` member instead. It is a text
column with no CHECK constraint (`bootstrap.sql.ts:48`), so this is a
type-and-render change with no migration.

---

## 7. Worker liveness

### 7.1 The gap

Nothing in the web process knows whether the worker exists. `docker-compose.yml`
declares no `healthcheck` on either service, and `restart: unless-stopped` will
restart a *crashed* process but not a hung one. The dashboard's setup notice
(`page.tsx:23-62`) warns about missing credentials and never about a missing
worker — the one failure that stops everything.

The user-visible symptom: a task sits at `running`, the pulse dot animates, and
nothing happens, indefinitely.

### 7.2 A heartbeat row

The `settings` table is a key/value store already (`bootstrap.sql.ts:124-127`)
and would work, but conflating operational state with user preferences means
every settings read touches a row the worker rewrites every few seconds. A
dedicated single-row table is cleaner and goes in `bootstrap.sql.ts` as a new
`CREATE TABLE IF NOT EXISTS` — no migration needed, since migrations are only
required for changes to *existing* tables (`migrations.ts:6-9`):

```sql
CREATE TABLE IF NOT EXISTS worker_status (
  id TEXT PRIMARY KEY,                    -- always 'worker'
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  pid INTEGER,
  version TEXT,                            -- git sha or package version
  active_job_id TEXT,                      -- NULL when idle
  active_task_id TEXT
);
```

The worker writes `heartbeat_at` on every tick — including while a job is in
flight, which means the heartbeat needs its own interval for the same reason the
cancellation poll does (§6.3). One interval serves both.

`active_task_id` is the field `spec-execution-honesty.md` §3 reads to tell
"admitted" from "in flight". Note it is *also* derivable from
`jobs.status = 'claimed'` (`runningTaskCount`, `queue.ts:61-68`, which nothing
calls). Both are kept: the jobs table is the transactional truth, and this
column is the heartbeat's own view of it, which is what makes a *stale* claim
detectable.

### 7.3 Liveness, not just presence

A row that was last written twenty minutes ago is more informative than no row.
The derived state:

| Condition | State |
|---|---|
| No row | `never_started` |
| `now - heartbeat_at` ≤ 3 × tick | `healthy` |
| ≤ 60s | `lagging` |
| > 60s | `stale` |

`stale` with an `active_task_id` set is the interesting one: it means the worker
died mid-stage, and the task it was holding will sit at `running` until someone
restarts the worker — at which point `requeueOrphanedJobs`
(`queue.ts:147-155`) returns the claimed job to `pending` and it runs again from
the top. Saying that out loud in the UI is most of the value of this section.

### 7.4 Surfaces

- **`GET /api/health`** — returns the derived state, the lag, and the active
  task. Also the endpoint `docker-compose.yml` gets a `healthcheck` against, on
  the *worker*'s behalf (the worker has no HTTP server of its own; the web
  service reports on it).
- **A dot in the nav.** `nav.tsx` renders a decorative accent dot at `:25`
  beside the product name. It becomes meaningful: green healthy, amber lagging,
  red stale, grey never started, with the state and lag in the title attribute.
- **The dashboard setup notice** gains a problem entry when the state is not
  `healthy`, in the same list as the credential warnings (`page.tsx:26-48`).

### 7.5 Why this makes concurrency safer later, and still not now

Running N jobs at once is the obvious next thought, and this spec deliberately
does not do it. `claimNextJob` (`queue.ts:77-110`) is already written for it —
the claim is atomic and the cap counts distinct tasks — so the change is in the
worker loop, not the queue.

The reason to wait: the product's bottleneck is human. Gates sit for hours; the
worker is idle most of the time. Concurrency multiplies simultaneous spend, and
until §4 and §5 exist there is no brake on that. After they exist, the heartbeat
in §7.2 has to grow from one row to one per in-flight job, which is a schema
change better made once, with the concurrency work, than pre-emptively here.

---

## 8. Notifications

### 8.1 One funnel already exists

Every transition worth telling a human about already passes through
`appendEvent` (`events/store.ts:50-74`) — `gate_opened`, `stage_failed`,
`pr_opened`, `task_finished` are all members of the `PipelineEvent` union
(`events/store.ts:15-33`). A dispatcher hooked there covers every notifiable
moment without a single new call site, and stays correct as new event types are
added.

The hook must not run inside the transaction. `appendEvent` opens one
(`:55`), and an outbound HTTP call inside a SQLite write transaction on a file
shared by two processes is how `SQLITE_BUSY` becomes a product feature. The
dispatch is scheduled after commit.

### 8.2 The two-process problem

Browser notifications need a browser. The worker — where almost every notifiable
event originates — has none, and the SSE route
(`src/app/api/tasks/[id]/stream/route.ts`) is scoped to a single task, so a user
on the board receives nothing about the task they are not looking at.

Therefore:

- **Browser notifications** ride a new **global** SSE stream,
  `GET /api/events/stream`, tailing the `events` table across all tasks with the
  same cursor mechanics the per-task route already uses. This endpoint is also
  what `spec-board-at-scale.md` §5's activity feed consumes, so it is specified
  here and reused there.
- **Webhooks** are dispatched by whichever process appended the event, which for
  pipeline events is the worker. This is the transport that works when no
  browser is open — which is the entire point of the feature.

### 8.3 Webhook, not integrations

One outbound `POST` with a JSON body, configured with a URL and an optional
shared secret, reaches Slack, Discord, ntfy, n8n, Zapier and any script the user
writes. A per-vendor integration would reach exactly one of those and would need
maintaining.

```jsonc
{
  "event": "gate_opened",
  "taskId": "task_…",
  "taskTitle": "Filter the dashboard board to today's tasks",
  "repo": "storefront",
  "stage": "PLAN_GATE",
  "url": "http://localhost:3000/tasks/task_…",
  "at": 1754500000000
}
```

Signed with `X-Signature: sha256=<hmac>` over the raw body when a secret is
configured. Delivery is fire-and-forget with a short timeout and three
exponential retries, and a failed delivery is logged and never blocks or fails
the pipeline. The secret is stored the way every other secret in this product
is: as the *name* of an environment variable, never the value — the rule
`repos.credential_ref` already follows (`schema.ts:33-37`).

### 8.4 Which events notify

Notifying on everything trains the user to ignore it. The default set is the
subset where a human is either blocked or has to decide:

| Event | Default | Why |
|---|---|---|
| `gate_opened` | on | The pipeline is stopped, waiting for you |
| `task_finished` | on | Terminal — completed, rejected, failed, cancelled |
| `pr_opened` | on | The deliverable exists |
| `stage_failed` | off | The worker retries twice; a transient failure is noise |
| `quota_warning` (§4.2) | on | Money |
| Everything else | off | The live log already has it |

---

## 9. Holding the queue and pausing a task

### 9.1 The gap

The only way to stop work is Cancel, and Cancel is terminal (`CANCELLED`, from
which nothing can be retried, edited or deleted). A user who wants to stop
*right now* because they are about to change a prompt, or because the bill looks
wrong, has to destroy tasks to do it.

### 9.2 Two different verbs

**Global hold** is an operational switch: a settings flag the worker reads at
the top of `tick()` (`worker/index.ts:145-147`, where `getSettings()` is already
called every tick). While held, the worker claims no new jobs and finishes the
one it has. Nothing about task state changes — no new status, no transition.
This is deliberately the cheapest possible implementation, and it is enough,
because "stop starting things" is the actual request.

**Per-task pause** is a task-level intent: finish the current stage, then park
instead of scheduling the next one. The natural seam is `scheduleStage`
(`orchestrator.ts:87-98`) — the single funnel — checking a `paused` flag on the
task before enqueueing.

The pause flag is a boolean column on `tasks`, added via `migrations.ts` as an
appended entry using `addColumn` (`migrations.ts:28-37`), not a new
`TaskStatus`. `stages.ts:74-101` already documents that two statuses (`on_queue`,
`gate_queued`) break the "status is derived from stage" rule and have to be set
explicitly; a third would compound a problem the codebase has already flagged.
Resuming clears the flag and calls `advanceTask` with the signal the stage
would have produced.

### 9.3 What pause does not do

It does not abort the running stage — that is Cancel's job (§6), and a pause
that killed work in flight would be a worse Cancel rather than a different verb.
The UI copy says "finishes the current stage, then waits", because a user who
expects an immediate stop and gets a five-minute Developer session is worse off
than one who was told.

---

## 10. Data model summary

New table, in `bootstrap.sql.ts` (`CREATE TABLE IF NOT EXISTS` is safe on both
fresh and existing databases):

- `worker_status` (§7.2)

New columns on existing tables, appended to `MIGRATIONS` in `migrations.ts` as a
single entry using `addColumn`:

```ts
{
  name: "spend controls and task pausing",
  up: (sqlite) => {
    addColumn(sqlite, "tasks", "max_cost_usd", "REAL");
    addColumn(sqlite, "tasks", "paused", "INTEGER NOT NULL DEFAULT 0");
  },
}
```

Settings blob additions (no migration — the blob merges against defaults,
`settings/store.ts:113-126`):

```ts
quotaEnforcement: "off" | "warn" | "hold";   // default "off"
maxCostPerStageUsd: number | null;           // default null
maxCostPerTaskUsd: number | null;            // default null
queueHeld: boolean;                          // default false
notifications: {
  browser: boolean;
  webhookUrl: string | null;
  webhookSecretRef: string | null;           // env var NAME
  events: Record<string, boolean>;
};
```

`updateSettingsSchema` (`validation/schemas.ts:168-178`) must be extended in the
same change. Note that this schema **already silently drops
`reworkMaxCycles` and `humanCodeReviewDefault`** because `z.object` strips
unknown keys and neither is declared — verify and fix that in the same edit, or
these new fields will be added to a form whose save path is already known to
discard two of its own fields.

---

## 11. Test plan

**Admission (unit, with a real temp DB)**
- `enforcement: "off"` → a start over the limit succeeds, exactly as today.
- `"warn"` → the start succeeds and a `quota_warning` event is appended.
- `"hold"` → `startTask` throws `QuotaError` and the task is left untouched;
  the batch path parks it at `on_queue`.
- Ordering: a task that is over quota **and** has an unmet prerequisite reports
  the dependency, not the quota.
- Ordering: a task that is over quota **and** has no free slot reports the
  quota.
- `overrideQuota: true` starts it; capacity and dependency refusals are not
  overridable by the same flag.
- `promoteQueue` stops on the first `QuotaError` rather than iterating the whole
  queue (assert the number of `costSince` calls).

**Budget (provider-level, with injected fakes)**
- OpenAI: a fake client returning a fixed usage per turn stops the loop on the
  turn that crosses `maxCostUsd`, and the thrown error carries the accumulated
  cost.
- Gemini: same, parameterised over the same fixture.
- Claude: `buildOptions` includes `maxBudgetUsd` when set and omits it when null.
- **The §5.4 regression:** a provider that throws `StageExecutionError` with a
  populated `partial` results in a `stage_runs` row with non-zero `cost_usd`.
  This test fails today.
- A budget stop is not retried by `handleJobFailure`.

**Cancellation**
- With a fake provider that resolves after N polls, cancelling the task mid-stage
  aborts within one poll interval.
- The stage run ends `cancelled`, not `failed`; the partial cost is recorded;
  `advanceTask` is not called a second time.
- Gemini and OpenAI both stop between turns when the signal fires between
  requests, not only during one.

**Heartbeat**
- No row → `never_started`. A row aged past each boundary → `lagging`, `stale`.
- A `stale` row with `active_task_id` set is reported as an interrupted stage.

**Notifications**
- The dispatcher runs after the `appendEvent` transaction commits, not inside it.
- A webhook failure does not fail the pipeline, and is retried three times.
- Only the enabled event types dispatch.
- The signature is computed over the exact bytes sent.

**Integration**
- Full pipeline with `maxCostPerTaskUsd` set below the first stage's cost →
  terminal `FAILED` naming the ceiling, workspace preserved.
- Queue held → the worker claims nothing and the in-flight job still completes.
- Task paused at a stage boundary → no job enqueued; resume schedules exactly
  the stage that was skipped.

---

## 12. Phasing

**Phase A — the partial-cost fix (§5.4) alone.** Independently valuable and
independently shippable: it makes `/usage` honest about every failed run today,
with no new settings, no new tables and no behaviour change beyond correct
numbers. Everything else in §5 depends on it.

**Phase B — cancellation (§6).** The controller, the poll, the Gemini plumbing,
the `cancelled` run status. Delivers the most visible promise in this spec — the
button labelled Cancel starts cancelling — and needs no schema change beyond a
status literal.

**Phase C — the heartbeat (§7).** One table, one endpoint, one dot. Unblocks
`spec-execution-honesty.md` §3 and the compose healthcheck.

**Phase D — quota enforcement (§4) and the per-task ceiling (§5.1-§5.5).** The
two money controls, together, because they share the Settings surface and the
"Start anyway" affordance.

**Phase E — notifications (§8) and hold/pause (§9).** Both are additive and
neither blocks anything else. The global SSE stream built here is a prerequisite
for `spec-board-at-scale.md` §5.

---

## 13. Open questions

1. **Should `hold` be the default for a fresh installation?** §4.7 chooses
   `off` so no existing install changes behaviour, and a fresh install has no
   limit configured anyway, which makes the enforcement mode moot until one is.
   But a user who types a limit almost certainly means it, so a case exists for
   defaulting to `hold` *the moment a limit is first saved* and saying so in the
   toast. That is a smaller, better-targeted default than a global one.
2. **Is the per-stage ceiling worth having alongside the per-task one?** The
   per-task ceiling is the one users think in. The per-stage ceiling exists to
   catch a single runaway session before it consumes the whole task budget in one
   go — but it may be entirely redundant, since the per-task check at
   `scheduleStage` plus the SDK's own `maxBudgetUsd` covers most of it. Worth
   dropping if the first month of data shows no case where they differ.
3. **Cancellation poll interval.** Two seconds is proposed with no measurement
   behind it. The real question is what an acceptable worst-case waste is: at
   two seconds it is at most one model turn, which is the right order of
   magnitude, but a stage doing long tool calls could be interrupted mid-write.
   Whether an abort mid-`Edit` can leave the workspace in a state the next stage
   trips over needs testing, not reasoning.
4. **Should a budget stop preserve the artifact?** §5.5 makes it terminal and
   discards the partial output, consistent with how a malformed artifact is
   handled today. `spec-agent-context.md` §6 argues the opposite for malformed
   artifacts — that the produced text should be shown and editable. If that
   argument wins there, it probably wins here too, and the two should resolve
   together rather than diverge.
5. **A webhook secret as an env var name is friction.** Every other secret in
   this product is a git credential, where the indirection is clearly right. A
   notification webhook secret is lower-stakes and the indirection may push users
   to configure no secret at all. The alternative — storing it encrypted at rest
   — needs a key, and there is nowhere to put one in a local-first single-user
   app that is not equally readable.
6. **Does the global SSE stream need its own backpressure?** The per-task route
   polls every 700ms with a 500-row limit (`stream/route.ts:15`, `store.ts:88`).
   Across all tasks with several browser tabs open, that is the same query
   multiplied. It is almost certainly fine on SQLite for this scale, and
   "almost certainly" is the kind of claim this spec set exists to stop making.
