# The Board at Scale — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Make the dashboard usable past the first few dozen tasks. Search
> and real filters, a card that says when something is stuck, archiving,
> a cross-task inbox, honest queue order, backup, and an API token for external
> triggers.
> **Prerequisite:** the pipeline as built. §6 consumes the global SSE stream
> specified in `spec-spend-and-operational-control.md` §8.2 and should follow
> it.
> **Related:** `spec-task-queue.md` (§5 the card and its menu, §9 the ordering
> rule §8 finally renders, §7.2 the deletion restriction §5 works around);
> `spec-execution-honesty.md` (§3 — what the card may claim; §3.1 here adds
> information without touching that);
> `spec-human-in-the-loop.md` (§6 — duplicate, reached from the card menu §3.3
> widens); `spec-spend-and-operational-control.md` (§8 — notifications, the
> push half of §6's pull);
> `spec-delivery-lifecycle.md` (§5.4 — the pull-request chips §3.1 renders).

---

## 1. Summary

The board is a fifteen-column kanban grid rendered from every task the filter
lets through (`task-board.tsx:125-201`). It was designed for a linear pipeline
with a handful of tasks in flight, and at that size it is good. Past that, four
things break.

**There is no way to find anything.** The entire filter surface is two date
pickers, Apply and Reset (`task-filter-bar.tsx`). Reset returns to
`defaultDateRange`, which is *today* (`task-filter.ts:39-45`). There is no text
search, no filter by repository, priority or status — and because Reset means
"today", **there is no view of all finished tasks at all**. A user looking for
something they shipped last week has to construct a date range for it.

**The card says nothing about time.** `TaskCard` renders the title, the repo
name, priority, difficulty, criticality and cost (`task-board.tsx:94-105`).
Nothing temporal. A task stuck for two hours in Development is pixel-identical
to one that entered ten seconds ago. Cards in the "Not delivered" column
(`:160`) do not say whether they failed, were rejected or were cancelled — all
three are lumped together by `currentStage` at `:137` — nor why: `failureReason`
appears only on the detail page (`tasks/[id]/page.tsx:118-122`).

**Nothing ever leaves.** `deleteCreatedTask` refuses any task past `CREATED`
(`orchestrator.ts:530-539`), and a started task has no menu at all — `TaskCardMenu`
renders only when `notStarted` (`task-board.tsx:60-72`). Every experiment stays
on the board forever, in `/usage`, in the per-refresh load, and in the dependency
picker, which excludes only `completed` (`service.ts:121-125`) and therefore
offers rejected, failed and cancelled tasks as prerequisites indefinitely.

**Finding what needs you means scanning.** `readEvents` is hard-scoped to one
task (`events/store.ts:88-92`) and the SSE route is per task. There is no
cross-task read of anything. Locating the three tasks awaiting a decision means
looking through fifteen columns for amber dots.

Underneath all of it: the board re-renders every four seconds
(`auto-refresh.tsx:12`), and each render issues two queries per task
(`page.tsx:77-81`).

---

## 2. Scope

**In scope**

- Card information density: age, stuck detection, terminal reason (§3).
- Search and filters that persist in the URL (§4).
- Archiving, and what it does to the dependency picker and `/usage` (§5).
- A cross-task inbox and activity feed (§6).
- Batch selection that survives a refresh, and more than one batch verb (§7).
- Rendering the real queue order (§8).
- The N+1 and the refresh cost (§9).
- Backup (§10) and an API token (§11).

**Out of scope**

- Drag-and-drop reordering. §8.4 explains why the ordering rule is derived, not
  stored, and what would have to change first.
- Notifications. `spec-spend-and-operational-control.md` §8 owns the push
  channel; §6 here is the pull view of the same data.
- Changing what the "running" badge claims — `spec-execution-honesty.md` §3
  owns it. §3.1 adds a line to the card and does not touch that logic.
- Multi-user views. Nothing in the product models a second user, and §11.3 keeps
  the token a label rather than an identity.

---

## 3. The card

### 3.1 A meta line

One line under the repo name (`task-board.tsx:94`), showing the two things a
board is for: *how long* and *what next*.

| Task state | Line |
|---|---|
| `CREATED` | "created 2h ago" |
| `on_queue` | "queued 2h ago · #3 in queue" (§8) |
| `running` | "Developer · 14m" — the current stage and its elapsed time |
| `awaiting_gate` | "waiting for you · 2d" |
| `gate_queued` | "approved · waiting for a slot" |
| terminal | "failed · 3h ago" / "rejected" / "cancelled" |

Elapsed time for a running stage comes from `stage_runs.started_at`, already
written by `markStageRunStatus` (`service.ts:455-463`), so it needs the latest
run per task — one query for the whole board rather than one per card (§9).

### 3.2 Stuck is a first-class state

The single most valuable thing a board can show is that something is not
progressing. Two thresholds, both derived rather than stored:

- A `running` stage whose `started_at` is older than a multiple of that stage's
  typical duration gets an amber "slow" marker.
- A `running` task the worker is **not** executing gets the treatment
  `spec-execution-honesty.md` §3 specifies. This spec renders it; that one
  decides what it means.

Absolute thresholds are wrong here — a `STAKEHOLDER_REFINEMENT` at 6 turns and a
`DEVELOPMENT` at 80 (`settings/store.ts:82-92`) have different natural
durations. Until `/usage` has enough history for a per-stage median, a simple
per-stage constant is honest enough, and the card says "slow" rather than
"stuck" because the product cannot yet tell the difference.

### 3.3 Terminal cards must say why

`failureReason` is a column on `tasks` (`schema.ts:69`) populated on every
terminal transition (`applyTransition`, `orchestrator.ts:115-116`) and rendered
on exactly one screen. The card shows it truncated, with the full text on hover.

The "Not delivered" column also stops being one bucket. `currentStage` already
distinguishes `REJECTED`, `FAILED` and `CANCELLED` (`task-board.tsx:137`); the
card renders which. Splitting into three *columns* is the wrong fix — the
comment at `:110-115` is right that a column per failure mode makes the board
worse — but a badge per card costs nothing.

### 3.4 The menu on a started task

`TaskCardMenu` is rendered only for `notStarted` tasks (`task-board.tsx:60-72`),
so Cancel, Retry and Duplicate are all detail-page-only. On a fifteen-column
board, acting on a task means navigating away from the view that told you to act.

The menu renders for every task, with items filtered by what the status allows —
the same predicate `TaskControls` already applies (`task-actions.tsx:198-199`).
Retry additionally consults the retryability flag
`spec-retry-recovery.md` §10 exposes, so the board never offers a button that
409s.

---

## 4. Search and filters

### 4.1 Reset should mean "everything"

`defaultDateRange` is today (`task-filter.ts:39-45`) and `filterBoardTasks`
keeps every open task regardless of date plus everything else inside the range
(`:77-82`). That default is good: a fresh board shows what is live plus today's
finished work.

What is wrong is that Reset returns to it, so "today" is both the default *and*
the widest thing the reset button can produce. A user who wants to see last
month's completed tasks must know to construct a range.

Reset clears the range entirely — all tasks, all dates — and the default on
first load stays "today". Two different actions, two different meanings.

### 4.2 The filters worth having

All in the URL, so a filtered board is linkable and survives the 4-second
refresh:

- **Text** — `?q=`, matched against title and description with SQL `LIKE`. Not
  full-text search: SQLite FTS5 is a virtual table and a migration, and at this
  scale `LIKE` over a few thousand rows is instant.
- **Repository** — `?repo=`, the filter users reach for most once more than one
  connection exists.
- **Priority** and **status** — `?priority=`, `?status=`. `listTasks` already
  accepts a status filter (`service.ts:99-108`) and the API already validates it
  against `TASK_STATUSES` (`validation/schemas.ts:53-55`); it is simply not
  exposed in the UI.

Filtering moves into the query rather than staying in `filterBoardTasks`, which
today receives every task and filters in JS (`page.tsx:77-85`). That is the same
change §9 needs for the N+1, and doing both at once is less work than either
alone.

### 4.3 Saved views

Once the filter state is a URL, a saved view is a stored URL with a name. Three
defaults ship: **Needs me** (`status=awaiting_gate`), **Active**
(the open statuses `task-filter.ts:17-23` already enumerates), and **Everything**.

This is deliberately not a new concept — it is a bookmark with a name, rendered
as a row of chips above the board.

### 4.4 Column overflow

A column has no cap and no scroll (`task-board.tsx:191-196`). Thirty completed
tasks make one column thirty cards tall and every sibling column a thin strip
beside it.

Each column body gets `max-height` and `overflow-y: auto`, and columns with more
than a threshold show "showing 20 of 137 — see all" linking to a filtered list
view. The grid layout's whole premise is fitting the board on one screen
(`:162-165`); an unbounded column defeats it.

### 4.5 A list view

The kanban is the wrong shape for two hundred tasks regardless of filtering. A
table view — title, repo, stage, status, age, cost, sortable, paginated — is the
right one, at `/tasks`, sharing the same filter state.

The board answers "what is happening now". A list answers "find the thing". Both
are needed; neither substitutes for the other.

---

## 5. Archiving

### 5.1 Why not deletion

`deleteCreatedTask` is restricted to `CREATED` for a stated reason: a started
task owns a workspace on disk that a plain row delete would orphan
(`spec-task-queue.md` §7.2, `orchestrator.ts:526-528`). That reasoning holds.

Archiving is not deletion. An archived task keeps every row — artifacts,
approvals, transcripts, cost — and stops appearing in the places where volume
hurts.

```ts
addColumn(sqlite, "tasks", "archived_at", "INTEGER");
```

### 5.2 What archiving hides

| Surface | Effect |
|---|---|
| Board | Hidden unless `?archived=1` |
| List view (§4.5) | Hidden by default, filterable |
| Dependency picker | Hidden — see §5.3 |
| `/usage` | **Still counted.** Archiving is not un-spending |
| Task detail page | Reachable by URL, with an "archived" banner and Unarchive |

The `/usage` row is the important one. Hiding archived tasks from cost
aggregates would let a user make an uncomfortable number disappear by tidying,
which is the opposite of what a cost screen is for.

### 5.3 The dependency picker is already wrong

`listDependencyOptions` excludes the task itself and every `completed` task
(`service.ts:121-125`), on the stated grounds that "a finished task is not a
meaningful prerequisite".

By that same reasoning `rejected`, `failed` and `cancelled` tasks should be
excluded too — and they are not. A user can today select a cancelled task as a
prerequisite, and since `incompleteDependencies` requires
`currentStage === "COMPLETED"` (`service.ts:275-277`), the dependent task can
**never** start. There is no override, and nothing in the UI explains it.

That is a live bug, independent of archiving, and the fix is one predicate:
exclude any task in a terminal stage, plus any archived task. It is worth
shipping on its own.

### 5.4 Auto-archive

A setting: archive terminal tasks older than N days, default off. Run by the
worker on the same slow cadence as any other housekeeping.

Off by default because a board that silently empties itself is disorienting, and
because the user who most needs archiving is the one who will turn it on
deliberately.

---

## 6. The inbox

### 6.1 What is missing

Everything about the event log is per task: `readEvents(taskId, afterSeq)`
(`events/store.ts:88-92`), and the SSE route is `/api/tasks/[id]/stream`. There
is no cross-task read of events, and no cross-task view of anything except the
board itself.

So the answer to "what needs me" is: scan fifteen columns for amber dots
(`task-board.tsx:79-84`), across however many pages of board the filter produced.

### 6.2 Needs-me is a query, not a feature

`listTasks({ status: "awaiting_gate" })` already works
(`service.ts:99-108`). The inbox is that query, rendered as a panel above the
board, with the gate name, how long it has waited, and the decision buttons
inline.

Inline decisions cost almost nothing: the gate endpoint is a plain JSON `POST`
(`api/tasks/[id]/gates/[gate]/route.ts`), which `GatePanel` already calls
(`task-actions.tsx:85-89`). The panel reuses the same component in a compact
mode.

The one gate that must **not** be decidable inline is `HUMAN_CODE_REVIEW`:
approving a diff without opening it is exactly the rubber-stamping the gate
exists to prevent. That row links to the review screen instead.

### 6.3 The activity feed

A reverse-chronological cross-task event list at `/activity`, backed by a
`readAllEvents(afterId, limit)` that orders by the `events.id` autoincrement
(`schema.ts:172`) rather than by `seq`, which is per-task and therefore not a
global ordering.

Live updates come from the global SSE stream
`spec-spend-and-operational-control.md` §8.2 specifies for notifications. The
two features are the pull and push halves of one capability, and building the
stream twice would be the waste.

---

## 7. Batch operations

### 7.1 The selection is destroyed by the refresh

`BatchSelectionProvider` resets its selection whenever `boardVersion` changes
(`batch-start.tsx:49-60`), and `boardVersion` is a digest of **every** task's
id, stage and status (`page.tsx:102`).

The reasoning behind that (the comment at `batch-start.tsx:40-47`) is sound in
its own terms: a checked task whose state moved is a stale selection, and
deriving the trigger from data rather than a timer avoids wiping a selection on
an idle poll. But the digest is board-wide. Combined with the 4-second refresh
(`auto-refresh.tsx:12`), ticking eight checkboxes while any pipeline is running
is a race against an unrelated task advancing a stage.

The fix keeps the intent and narrows the blast radius: instead of clearing the
whole set when the digest changes, drop **only** the selected ids that vanished
or became ineligible. That is the same computation the digest was standing in
for, applied per task:

```ts
const eligible = new Set(tasks.filter(isSelectable).map((t) => t.id));
if (selected.size > 0 && [...selected].some((id) => !eligible.has(id))) {
  setSelected(new Set([...selected].filter((id) => eligible.has(id))));
}
```

Still a render-time adjustment, still pure, and a task advancing in another
column no longer touches the selection.

### 7.2 More than one verb

Start is the only batch action. Clearing twenty finished experiments is twenty
dropdown opens and twenty `window.confirm` dialogs (`task-actions.tsx:226-231`).

Batch **Archive** (§5) and batch **Cancel** join it, with the same
partial-failure reporting `startTasksBatch` already produces — a per-task
`{ started, queued, reason }` result (`orchestrator.ts:357-364`) rather than an
all-or-nothing outcome. That shape generalises directly.

Batch Delete is not offered: deletion is `CREATED`-only and archiving covers the
real need.

### 7.3 Selection outside `CREATED`

`showCheckbox` requires `notStarted` and excludes `on_queue`
(`task-board.tsx:44`). For Start that is right. For Archive it is not — the tasks
worth archiving are exactly the terminal ones.

The checkbox becomes available on any task, and the batch bar enables each verb
based on what the selection supports, reporting mixed selections plainly
("archive 12 · 3 selected tasks cannot be archived").

---

## 8. Queue order

### 8.1 The column is sorted backwards

Promotion order is priority descending, then difficulty ascending, then
oldest-queued-first (`sortByPriorityThenDifficulty`, `orchestrator.ts:280-286`,
applied to a list pre-sorted by `updatedAt` at `:330`).

The On Queue column renders in `listTasks` order, which is
`orderBy(desc(tasks.createdAt))` (`service.ts:106`) — newest first. So the card
at the top of the queue column is, all else equal, the **last** one that will
run.

The column sorts by the real rule, and each card shows its position (§3.1).

### 8.2 One rule, two implementations

The ranking exists twice: as SQL `CASE` expressions in `claimNextJob`
(`queue.ts:22-26`) and as JS lookup tables in the orchestrator
(`orchestrator.ts:261-272`). The comment at `orchestrator.ts:256-259` explains
why — the batch sorts already-fetched rows rather than issuing a query — and
that is a reasonable trade.

It becomes unreasonable once the UI renders the order, because a third consumer
means a third chance to drift. The two rank tables move to one module exporting
both the JS comparator and the SQL fragment, so the definition is single even
though the execution is not.

### 8.3 "Run this next"

A menu item that promotes one queued task to the front. The honest
implementation is not a stored position but a bump of `updated_at`, which is
already the oldest-first tiebreaker (`orchestrator.ts:330`) — it only reorders
within an equal priority and difficulty, which is exactly what "next among
equals" means.

Anything stronger requires §8.4.

### 8.4 Why there is no drag-to-reorder

Order is *derived* from priority, difficulty and queue time. There is no
position column, and adding one means the board becomes the authority on
execution order while `claimNextJob` still computes its own — two sources of
truth for the same decision, in two processes.

Making order explicit is a coherent design, and it is a different one:
`claimNextJob` would order by the stored position and the derived rule would
become the default seed. Worth doing only if users actually fight the ranking,
which editable priority (a change worth making on its own, since priority is
frozen after start today) would reveal first.

---

## 9. What the board costs to render

### 9.1 The N+1

```ts
// src/app/(dashboard)/page.tsx:77-81
const allTasks: BoardTask[] = listTasks().map((task) => ({
  ...task,
  costUsd: totalCostForTask(task.id),
  dependsOn: listDependencies(task.id),
}));
```

One query for the list, then two per task. A hundred tasks is 201 queries, on
every render, and the page is `force-dynamic` (`page.tsx:21`) with a 4-second
refresh. The API route does the same (`api/tasks/route.ts:31-35`).

Both collapse into aggregates: one `GROUP BY task_id` over `stage_runs` for
cost, one over `task_dependencies` joined to `tasks` for prerequisites. The
per-task functions stay for the detail page, which legitimately wants one task.

SQLite on a local file makes 201 queries survivable, which is why this has not
hurt yet. It becomes the dominant cost the moment §4's filters let a user ask
for everything.

### 9.2 The refresh interval

Four seconds, fixed (`auto-refresh.tsx:12`). Every tick re-renders the whole
RSC payload for every task on the board.

Two cheap improvements:

- **Pause when the tab is hidden.** `document.visibilityState` — a background tab
  currently polls forever.
- **Back off when nothing is live.** A board with no `running` or
  `awaiting_gate` task does not need four-second granularity; 30 seconds is
  plenty, and the data to decide is already in the render.

### 9.3 The digest is recomputed to be thrown away

`boardVersion` builds a string of every task's id, stage and status
(`page.tsx:102`) purely so the selection provider can compare it. After §7.1
that comparison moves to per-id eligibility, and the digest can go.

---

## 10. Backup

Everything — tasks, artifacts, approvals, transcripts and attachment BLOBs
(`schema.ts:145`) — lives in one SQLite file, and the product cannot copy it.
The only database scripts are `db:push` and `db:studio` (`package.json:13-14`).

`better-sqlite3` exposes the online backup API on the handle the code already
reaches: `db.$client` is used for `close()` (`db/client.ts:80`), and the same
handle offers `.backup(path)`, which is safe against a live WAL database — which
matters, because the worker is writing to it concurrently.

Ship it as `npm run db:backup`, writing a timestamped file, plus a documented
cron example. Restore stays a documented file-copy with both processes stopped.

**No restore button.** A one-click overwrite of the live database from the UI is
a crowbar pointed at the only copy of everything, in a product where the web
process and the worker both hold the file open. The asymmetry is deliberate:
backup is safe to make trivial, restore is not.

---

## 11. An API token

### 11.1 What it unlocks

`POST /api/tasks` already accepts `start: true` (`validation/schemas.ts:40-46`,
`api/tasks/route.ts:88-96`). It is a ready-made trigger for CI, for a webhook on
an issue label, or for a script — and there is no safe way to reach it, because
there is no authentication at all.

It is also what makes approving a gate from a phone possible, which matters
because gates are precisely what blocks the pipeline while the user is away from
their machine.

### 11.2 Shape

A bearer token, stored hashed, checked by middleware on `/api/*` when one is
configured. When none is configured the API is open, exactly as today — a
local-first tool binding to localhost should not require setup to work.

The secret is provided as an environment variable name, following the rule
`repos.credential_ref` already establishes (`schema.ts:33-37`): the database
stores the name, never the value.

### 11.3 A label, not an identity

Each token has a name — "CI", "phone" — recorded on the actions it takes, so the
activity feed can say *which automation* did something.

That is the whole scope. It is not authentication for a second person: nothing
else in the product models a user, `approvals` records a decision without an
actor (`schema.ts:186-199`), and building half an identity system would create
an accountability story the rest of the product cannot honour.

---

## 12. Data model summary

One appended `MIGRATIONS` entry (`migrations.ts:39-64`):

```ts
{
  name: "task archiving",
  up: (sqlite) => {
    addColumn(sqlite, "tasks", "archived_at", "INTEGER");
  },
}
```

One new table in `bootstrap.sql.ts` (`CREATE TABLE IF NOT EXISTS`), only if §11
ships:

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_used_at INTEGER
);
```

Settings blob additions (merged against defaults,
`settings/store.ts:113-126`): `autoArchiveDays: number | null` (default
`null`), `boardRefreshMs: number` (default `4000`).

Indexes worth adding with §4's query-side filtering: `tasks(archived_at)` and
`tasks(repo_id)`. `tasks(status)` and `tasks(current_stage)` already exist
(`bootstrap.sql.ts:40-41`).

---

## 13. Test plan

**Filtering (pure)**
- `filterBoardTasks` keeps open-status tasks outside the range, and excludes
  terminal tasks inside it only when the range excludes them — the existing
  behaviour, asserted as a regression before the reset semantics change.
- A cleared range returns every task; the default first load returns today's.

**Queries (temp DB)**
- The aggregate cost query returns the same values as `totalCostForTask` per
  task, parameterised over tasks with zero, one and several stage runs.
- The dependency aggregate matches `listDependencies` per task.
- `listDependencyOptions` excludes terminal-stage tasks. **This test fails
  today** and is §5.3's live bug.
- `listDependencyOptions` excludes archived tasks.
- Text search matches title and description, case-insensitively.

**Archiving**
- An archived task disappears from the board and the picker, stays in `/usage`
  totals, and is reachable by URL.
- Unarchiving restores it everywhere.

**Batch selection (component)**
- A selection survives a board refresh in which an unrelated task changes stage.
  **This test fails today.**
- A selected task that becomes ineligible is dropped from the selection while
  the rest survive.
- Mixed selections enable only the verbs every selected task supports.

**Queue order**
- The On Queue column renders in the same order `promoteQueue` would consume,
  parameterised over ties in priority and difficulty.
- The shared rank module produces the same ordering as the SQL fragment, over a
  fixture covering every priority × difficulty combination including NULL
  difficulty.

**Inbox**
- The needs-me query returns exactly `awaiting_gate` tasks.
- An inline approval hits the same endpoint as the gate panel.
- `HUMAN_CODE_REVIEW` rows link out instead of offering inline approval.

**Backup**
- `db:backup` produces a file that opens and contains the same task count, with
  a second connection writing during the copy.

---

## 14. Phasing

Ordered by value over effort, not by section number.

**Phase A — the dependency-picker bug (§5.3) and Reset meaning "everything"
(§4.1).** Two predicates. One fixes a state where a task can never start; the
other makes finished work findable. Neither needs schema or new UI.

**Phase B — the card meta line and terminal reasons (§3.1, §3.3), and the menu
on started tasks (§3.4).** Pure presentation over data that already exists, and
it is what turns the board from a status display into something you can act on.

**Phase C — batch selection survival (§7.1) and the N+1 (§9.1).** Both are
small, both are felt every four seconds, and §9.1 is a prerequisite for §4's
filters not making things worse.

**Phase D — search and filters (§4.2-§4.4), with query-side filtering.** The
largest single improvement for anyone past fifty tasks.

**Phase E — archiving (§5) and batch verbs (§7.2-§7.3).** Together, because
batch archive is the reason archiving is worth having.

**Phase F — the inbox (§6.2).** Depends on nothing; deferred only because the
board improvements above reduce how badly it is needed.

**Phase G — backup (§10), the list view (§4.5), queue order (§8), the activity
feed (§6.3) and the API token (§11).** Independent, individually valuable, and
none of them blocking.

---

## 15. Open questions

1. **Is the kanban the right primary view at all?** §4.5 adds a list beside it
   rather than replacing it, on the grounds that they answer different
   questions. But fifteen columns for a pipeline where a task occupies one at a
   time may simply be the wrong shape, and a list with a stage column plus a
   compact pipeline visualisation per task might beat both. That is a redesign,
   not a feature, and it should not be decided inside this spec.
2. **Does "slow" need per-stage medians before it ships (§3.2)?** Constants are
   proposed as honest enough. The risk is a marker that cries wolf on every
   `DEVELOPMENT` run and is then ignored — which is worse than no marker,
   because it trains the user to dismiss the one signal that matters.
   `spec-cost-observability.md` §4's provenance columns would let the median be
   computed per stage *and model*, which is the version worth having.
3. **Should archiving be automatic by default?** §5.4 ships it off. The
   counter-argument is that the users who most need it will never find the
   setting, and a 90-day default would be invisible to everyone else. This is a
   defaults question that wants usage data nobody has yet.
4. **Inline gate approval may be a mistake even for the two gates that allow
   it.** §6.2 excludes `HUMAN_CODE_REVIEW` on the reasoning that approving a
   diff you have not opened defeats the gate. The same argument applies weakly
   to `PLAN_GATE` — approving a technical plan from a one-line inbox row is not
   reading the plan. The inbox may be right to link out for every gate and only
   ever *show* what is waiting.
5. **Editable priority after start.** §8.4 mentions it as the cheap way to
   discover whether users fight the ranking. It is genuinely cheap — priority is
   read live by the join in `claimNextJob` (`queue.ts:91-93`), so a change
   affects future claims immediately and nothing else — but it also breaks the
   current invariant that a started task's fields are frozen
   (`orchestrator.ts:459-463`), and that invariant is load-bearing for the
   audit trail's readability.
6. **An API token with no identity may be worse than none.** §11.3 scopes it as
   a label. The risk is that once an HTTP endpoint accepts a bearer token,
   people will expose it beyond localhost, at which point "single user by
   design" stops being true in practice while remaining true in the code. The
   safer version is a token that only permits `POST /api/tasks` and gate
   decisions, and never the settings or repository endpoints.
