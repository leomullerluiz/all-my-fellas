# Task Queue — Deferred Start — Technical Specification

> **Version:** 0.2 (design proposal — nothing in this document is implemented)
> **Scope:** Let a user create tasks that sit in the **Created** column until
> explicitly started, with per-card **Start / Edit / Delete** actions.
> **Prerequisite:** the pipeline described in `spec-esteira-multiagente.md`, as built.

**Changes since 0.1** — all four open questions from 0.1 were answered by the
product owner and are now settled decisions:

- No "Start all" button. Start is per card. (§2)
- The card stops being a link; **only the title navigates** to the detail page.
  This replaces the overlay workaround proposed in 0.1. (§5.2)
- The `running` badge must be **literally true**. Enforced by admission control:
  a task cannot be started unless a slot is free. This removes the
  "waiting for a worker slot" state 0.1 proposed. (§8)
- Priority is a marker, and it orders execution when several tasks compete —
  highest priority first, lowest complexity as tiebreaker. (§9)

---

## 1. Summary

Today `POST /api/tasks` creates a task and immediately enters the pipeline, so
the **Created** column on the board is always empty — a task passes through
`CREATED` without ever being observable there.

This change decouples the two: creating a task leaves it parked at `CREATED`,
and a task only enters the Stakeholder stage when the user says so. That turns
the board's first column into a real backlog: write up several pieces of work,
then release them one at a time when you are ready to spend the quota.

**The backend already supports the deferred start.** `createTask` and
`startTask` are already separate functions, and the state machine already has an
explicit `start` signal that is only valid from `CREATED`:

```ts
// src/server/pipeline/orchestrator.ts — exists today
export function startTask(taskId: string): void {
  advanceTask(taskId, { kind: "start" });
}

export function createAndStartTask(input) {   // ← the only thing coupling them
  const created = createTask(input);
  startTask(created.id);
  return getTask(created.id) ?? created;
}
```

`createTask` on its own already leaves the task at `CREATED` with no queued job.

The genuinely new mechanism is **admission control** (§8): the pipeline gains a
hard cap on how many tasks may be in flight at once, enforced at the moment of
starting rather than deep inside the worker. That is what makes the `running`
badge truthful.

---

## 2. Scope

**In scope**

- Task creation no longer starts the pipeline.
- A per-card overflow menu on **Created** cards: Start, Edit, Delete.
- Admission control so that at most `MAX_PARALLEL_TASKS` tasks are ever in
  flight, enforced when starting.
- Priority-aware execution ordering.
- Editing and deleting a not-yet-started task.
- Making the task detail page coherent for a not-yet-started task.

**Explicit non-goals**

- **No "Start all" / bulk start.** Every start is a deliberate, per-card action.
- Reordering the queue by drag and drop.
- Scheduling a start for a future time.
- Auto-promoting the next queued task when a slot frees.
- Editing or deleting a task that has already started.

---

## 3. State model

No new stage and no new task status.

| Stage | Task status | Meaning | Menu shown |
|---|---|---|---|
| `CREATED` | `queued` | Written up, not started. **Newly reachable and persistent.** | Start · Edit · Delete |
| `STAKEHOLDER_REFINEMENT` … `DELIVERY` | `running` (holding a slot) / `awaiting_gate` (slot released, see §8.4) | In flight | — |
| terminal | `completed` / `rejected` / `failed` / `cancelled` | Finished, slot released | — |

`statusForStage("CREATED")` already returns `queued`, so
`src/server/pipeline/stages.ts` needs no change.

**But the label does.** `queued` currently renders as "Queued", which implies
the system will pick the task up on its own. It must read **"Not started"** in
`StatusBadge`. This is the single most important wording change in the feature:
if the badge says "Queued", users will wait for something that never happens.

> **Rejected alternative:** adding a `draft` status. It would need a schema
> change, a new value in `TASK_STATUSES`, and updates everywhere the union is
> matched — all to express something `CREATED` + `queued` already expresses
> unambiguously once relabelled.

---

## 4. Creation flow

`POST /api/tasks` stops calling `startTask`. It accepts an optional flag so the
create-and-run-now path is still one click:

```jsonc
POST /api/tasks
{
  "repoId": "repo_…",
  "title": "…",
  "description": "…",
  "priority": "medium",
  "start": false        // optional, default false
}
```

The **New task** form gets two submit buttons:

- **Add to queue** (primary) → `start: false`, redirect to `/` with the new card
  visible in **Created**.
- **Start now** (secondary) → `start: true`, redirect to `/tasks/{id}`.

Defaulting `start` to `false` makes the safe option the default: the failure
mode of accidentally queueing is a card sitting still, while the failure mode of
accidentally starting is spent quota and a clone on disk.

**"Start now" is subject to admission control** (§8) exactly like the card
menu's Start. When no slot is free, the button is disabled with the reason
shown, and the task can still be added to the queue.

---

## 5. Card structure and menu

### 5.1 The card stops being a link

Today the entire card is one `<Link>`:

```tsx
<Link href={`/tasks/${task.id}`} className="block …">
  {/* title, repo, badges — everything */}
</Link>
```

That is what made an in-card menu button awkward: a `<button>` inside an `<a>`
is invalid HTML and breaks both keyboard navigation and screen readers.

**New structure — the title is the only navigation target:**

```tsx
<div className="rounded-md border border-border bg-surface-raised p-3 …">
  <div className="flex items-start justify-between gap-2">
    <h3 className="text-sm font-medium leading-snug">
      <Link href={`/tasks/${task.id}`} className="hover:text-accent …">
        {task.title}
      </Link>
    </h3>

    {/* the top-right corner: menu on CREATED cards, status dot otherwise */}
    {isCreated ? <TaskCardMenu task={task} /> : <StatusDot status={task.status} />}
  </div>

  <p className="mt-1 truncate text-[11px] text-muted">{task.repo.name}</p>
  <div className="mt-2 flex flex-wrap gap-1">{/* badges */}</div>
</div>
```

The link and the button are now siblings. No overlay, no `stopPropagation`, no
nested interactive elements.

**Applies to every card, not just `CREATED` ones.** Keeping half the cards
fully clickable and half not would be worse than either choice made
consistently.

**Accepted cost:** the click target shrinks from the whole card to the title
text. Two mitigations, both cheap:

- Give the title link generous vertical padding so the hit area covers the full
  header row height, not just the glyphs.
- The title wraps rather than truncating (it already does), so long titles are
  larger targets rather than smaller ones.

The repository name and the badges become plain, non-interactive text.

### 5.2 The top-right corner

`TaskCard` currently renders a status dot there — pulsing accent for `running`,
solid warning for `awaiting_gate`, nothing otherwise. A `CREATED` card renders
nothing, so **the corner is free** and the menu displaces no existing
affordance.

### 5.3 Menu behaviour

Trigger: an icon button (`MoreVertical` from `lucide-react`, already a
dependency), `aria-label="Task actions"`, `aria-haspopup="menu"`,
`aria-expanded`.

| Item | Action | Enabled when | Confirmation |
|---|---|---|---|
| **Start** | `POST /api/tasks/:id/start`, then `router.refresh()` | A slot is free (§8) | None — reversible via Cancel |
| **Edit** | Navigate to `/tasks/:id/edit` | Always (task is `CREATED`) | — |
| **Delete** | `DELETE /api/tasks/:id`, then `router.refresh()` | Always | **Required** |

Interaction requirements:

- Opens on click and on `Enter`/`Space`; closes on `Escape`, on outside click,
  and after any item is chosen.
- Arrow keys move between items; focus returns to the trigger on close.
- While a request is in flight the menu is disabled and the item shows a pending
  label, so a double click cannot fire two starts.
- Errors surface inline on the card, not in a `window.alert`.
- A disabled **Start** must say *why*: "Limit of N tasks in progress reached"
  plus the name of a task currently holding a slot. A disabled control with no
  explanation reads as a bug.

Delete confirmation must name the task — a bare "Are you sure?" on a board of
similar-looking cards is how the wrong one gets deleted.

> **`AutoRefresh` interaction:** the board calls `router.refresh()` every 4s.
> An open menu must survive a refresh. Component state does survive an RSC
> refresh, but only if the card keeps a stable React key (`task.id`, as today).
> Worth an explicit test — a menu that closes itself every four seconds is
> unusable.

---

## 6. Editing

**Route:** `/tasks/[id]/edit`, a server component that loads the task, calls
`notFound()` if it does not exist, and redirects to `/tasks/[id]` if the task
has already left `CREATED`.

**Form:** reuse the existing `NewTaskForm`, parameterised with a mode
(`create` | `edit`), initial values, submit label and target endpoint. The
Stakeholder-preview panel stays — it is more useful here than at creation, since
the point of editing is usually to sharpen the description the first agent will
receive.

**Editable fields:** `title`, `description`, `priority`, `repoId`.

All four are safe to change while `CREATED` because nothing derived from them
exists yet: the branch name is computed from the title at workspace-preparation
time, and no clone exists to invalidate when the repository changes.

**Validation:** reuse `createTaskSchema` — the same rules must apply, or a task
could be edited into a state it could not have been created in.

---

## 7. API

| Route | Behaviour | Failure modes |
|---|---|---|
| `POST /api/tasks` | Creates at `CREATED`. Starts only when `start: true`. | 400 invalid · 400 unknown repo · **409 no slot free** (when `start: true`) |
| `POST /api/tasks/:id/start` | Admission check, then `startTask(id)`. | 404 · **409 already started** · **409 no slot free** |
| `PATCH /api/tasks/:id` | Updates the four editable fields. | 404 · 400 invalid · **409 already started** |
| `DELETE /api/tasks/:id` | Hard-deletes the task. | 404 · **409 already started** |
| `POST /api/tasks/:id/retry` | Existing route — **now also admission-checked** (§8.3). | 404 · 409 not failed · **409 no slot free** |

### 7.1 The 409s are the interesting part

Two browser tabs showing the same stale board is the normal case, not an edge
case — the board auto-refreshes on an interval, and a user can act on a card in
the gap between refreshes.

**Double-start is already guarded.** `nextTransition` throws
`InvalidTransitionError` for a `start` signal from any stage other than
`CREATED`, so a second caller cannot double-start. The work is in the API layer:
catch `InvalidTransitionError` and map it to **409** with a message the UI can
show, rather than letting it reach `serverError` as a 500.

**Capacity must be re-checked server-side.** A disabled menu item is a hint, not
a guarantee — the board may be up to four seconds stale, and two tabs can both
see a free slot. The check and the transition must happen in **one SQLite
transaction**, or two concurrent starts can both pass the check (§8.2).

**Edit and delete need an explicit stage check** — re-read the task inside the
handler and reject unless `currentStage === "CREATED"`.

### 7.2 Deletion mechanics

`PRAGMA foreign_keys = ON` is set at bootstrap and every child table cascades
from `tasks` (`stage_runs`, `artifacts`, `agent_runs` via `stage_runs`, `events`,
`approvals`, `jobs`), so a single `DELETE FROM tasks WHERE id = ?` suffices.

A `CREATED` task has no workspace on disk (`workspacePath` is `NULL` until the
first stage that needs one), so there is nothing to clean up. **If deletion is
ever extended to finished tasks (§12), it must also remove the workspace
directory** — that is the reason to keep the restriction for now rather than
allowing it everywhere and fixing it later.

Deleting a task also frees its repository for removal, since `deleteRepo`
refuses while any task references it.

---

## 8. Admission control

**Requirement:** the `running` badge must be literally true. A card showing
"an agent is running" must mean an agent is running right now.

### 8.1 Why the naive version fails

`MAX_PARALLEL_TASKS` defaults to `1`, and today it is enforced only inside
`claimNextJob`, which counts distinct tasks holding a claimed job. Nothing stops
five tasks from being *started*: all five would move to
`STAKEHOLDER_REFINEMENT` with status `running`, four would sit with an unclaimed
job, and four cards would show a pulsing "an agent is running" dot while nothing
happened.

Version 0.1 proposed showing a distinct "waiting for a worker slot" state.
**That is rejected.** Making the queue visible is worse than not letting it form:
it adds a state to the UI, a state to reason about, and it still means the user
started work that is not running.

### 8.2 The rule

> A task may be **started** only if the number of **active** tasks is below
> `MAX_PARALLEL_TASKS`.
>
> **Active** = task status is `running`. A task `awaiting_gate` does not count
> — see §8.4.

Because only active tasks can own jobs, capping admission at N caps concurrent
jobs at N. The worker never has to queue, so `running` is always truthful. The
existing `claimNextJob(maxParallelTasks)` cap **stays** as a backstop — it should
now be unreachable, and a test should assert that.

**Implementation shape** — the count and the transition must be atomic:

```ts
// src/server/pipeline/orchestrator.ts (sketch)
export function startTaskWithAdmission(taskId: string): Transition {
  return db.transaction((tx) => {
    const active = countActiveTasks(tx);              // status = 'running'
    if (active >= getSettings().maxParallelTasks) {
      throw new CapacityError(active, blockingTaskTitles(tx));
    }
    return advanceTask(taskId, { kind: "start" });    // throws if not CREATED
  });
}
```

Reading the count outside the transaction and then transitioning would let two
concurrent requests both observe `active = 0` and both start.

### 8.3 What consumes and releases a slot

| Event | Effect on capacity |
|---|---|
| Start a `CREATED` task | **Takes** a slot — admission-checked |
| Retry a `failed` task | **Takes** a slot — `failed` is terminal, so a retry is a re-admission and **must be admission-checked too** |
| Task reaches a gate | **Releases** its slot — see §8.4 |
| Gate approved, or `request_changes` that resumes the task | **Takes** a slot — admission-checked, exactly like a start or retry |
| Gate rejected, or `request_changes` that exhausts the rework budget | No slot to take — terminal, already released at the gate |
| Task reaches any other terminal stage | **Releases** its slot |
| Cancel a task | **Releases** its slot |

The retry case is easy to miss: `retryTask` moves a terminal task back into the
pipeline, which needs its own capacity check just like a fresh start.

### 8.4 Gated tasks do not hold a slot

A task parked at `PLAN_GATE`, `HUMAN_CODE_REVIEW` or `STAKEHOLDER_GATE` is not
executing, and it does **not** count as active. With `MAX_PARALLEL_TASKS = 1`,
a task waiting for your approval no longer blocks you from starting or
retrying something else — you can work another task while a gate sits open.

The naive version of this rule would break the invariant in §8.1: if gated
tasks release their slot unconditionally, approving one can resume it into
`running` while another task is *already* running, and the badge lies again.
The fix is that **resuming** a gated task is itself admission-checked: `decideGate`
computes the transition first, and only calls the same `assertSlotAvailable`
guard that `startTask`/`retryTask` use when the outcome is a `run` transition
(an `approve`, or a `request_changes` that has budget left). `reject` and an
exhausted `request_changes` are terminal and need no check — they release
whatever slot the task was going to need, they never take one.

This means approving a gate can itself now return a 409: if another task took
the freed slot while this one waited for a decision, the approver sees the
same `CapacityError` a blocked `start` would, naming the task to resolve
first. The gate decision (and any request-changes comment) is not recorded in
that case — the check and the resume share one transaction, so a refused
approval leaves the task exactly as it was, free to retry once a slot opens.

### 8.5 Freeing a slot does not auto-start anything

When a task finishes, the next queued task does **not** start automatically —
`Start` stays a deliberate action, per the non-goals in §2. The board's next
`AutoRefresh` tick re-enables the Start items, and the user chooses which one
goes next.

This is what makes the priority ordering in §9 mostly advisory rather than
load-bearing: with the default `MAX_PARALLEL_TASKS = 1`, the user *is* the
scheduler.

---

## 9. Priority and execution order

Priority serves two purposes, in this order:

**1. As a marker.** It is a label on the card, and it travels into the prompt
the agents receive (`buildStagePrompt` already includes it). This is its primary
role and it needs no code change.

**2. As a tiebreaker when several tasks compete for the worker.** When more than
one job is eligible in the same tick, the worker picks the one with the highest
priority, and among equal priorities the lowest estimated complexity.

### 9.1 The ordering rule

`claimNextJob` currently orders strictly FIFO:

```ts
.orderBy(asc(jobs.runAfter), asc(jobs.createdAt))    // today
```

It becomes:

```sql
ORDER BY
  CASE tasks.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                      WHEN 'medium' THEN 2 ELSE 3 END,
  CASE tasks.difficulty WHEN 'S' THEN 0 WHEN 'L' THEN 2 ELSE 1 END,  -- NULL → 1
  jobs.run_after,
  jobs.created_at
```

`jobs` carries neither field, so `claimNextJob` must join `tasks`. That function
runs inside the claim transaction on every worker tick, so the join needs an
index on `jobs(status, run_after)` (exists) plus the primary key lookup on
`tasks` (exists). No new index required.

### 9.2 Complexity is unknown when a task starts

`tasks.difficulty` (S/M/L) is set by the **Architect**, at the fourth stage. A
task that has just been started has `difficulty = NULL`, so "lowest complexity
first" cannot be applied at admission time — only later, once a task has been
estimated.

The rule above treats `NULL` as `M`: neutral, so an un-estimated task neither
jumps the queue nor is starved behind estimated ones. Sorting `NULL` last would
mean a fresh urgent task loses to an already-estimated urgent task forever.

### 9.3 Honest assessment of the impact

With `MAX_PARALLEL_TASKS = 1` and admission control in place, **at most one task
is ever active, so the job queue almost never has two eligible jobs**. The
ordering rule will rarely fire.

It matters in exactly two situations, both worth supporting:

- `MAX_PARALLEL_TASKS > 1`, where several active tasks genuinely compete each
  tick.
- A retry or a rework cycle enqueued while another task's job is pending.

Implement it because it is cheap and because the UI already promises that
priority means something, but do not expect it to be visible day to day. The
user remains the real scheduler (§8.5).

---

## 10. Detail page for a not-started task

`TaskControls` currently offers **Cancel** for any task with status `queued`,
which for a `CREATED` task produces a `CANCELLED` terminal state: a dead card
that can never be started, edited, or removed. That zombie becomes easy to
create once tasks linger in `CREATED`.

Revised controls by state:

| Task state | Controls |
|---|---|
| `CREATED` | **Start** (admission-checked) · **Edit** · **Delete** — no Cancel |
| In flight | Cancel |
| `failed` | Retry (admission-checked) · Cancel |
| Other terminal | none |

**Do not mount `LiveLog` for a `CREATED` task.** It opens an `EventSource` that
polls the `events` table every 700 ms and only closes on a terminal status. That
window is short today; with tasks parked for hours it is a pointless open
connection per tab. Render a short explanation and the Start button instead.

The rest of the page degrades naturally — timeline, artifact tabs and approvals
are already empty-state aware.

---

## 11. Events

Add two variants to `PipelineEvent` in `src/server/events/store.ts`:

```ts
| { type: "task_started" }
| { type: "task_edited"; fields: string[] }   // names only, never values
```

`task_created` already exists, so a queued task's timeline reads
*created → edited → started → stage_started* — exactly the audit trail you want
when a task produced a surprising brief and you need to know what the
Stakeholder was actually given.

`fields` carries field **names** only. Logging old and new descriptions would
duplicate free text into the event log for no benefit; the current value is
already on the task row.

Deletion logs nothing — the events cascade away with the task.

---

## 12. Test plan

**Unit — orchestrator and admission**
- `createTask` alone leaves the task at `CREATED` with no job enqueued.
- `startTask` moves `CREATED → STAKEHOLDER_REFINEMENT` and enqueues one job.
- A second `startTask` on the same task throws `InvalidTransitionError`.
- With `MAX_PARALLEL_TASKS = 1` and one `running` task, starting a second throws
  `CapacityError`; the same setup with the first task `awaiting_gate` instead
  does **not** throw.
- Cancelling or completing the active task frees the slot.
- `retryTask` on a `failed` task is refused when no slot is free.
- `decideGate` resuming a task into `run` is refused when no slot is free, and
  the gate decision is not recorded; `reject` never needs a free slot.
- **Concurrency:** two `startTaskWithAdmission` calls racing for the last slot
  produce exactly one start and one `CapacityError`.
- **Invariant:** with admission control on, `claimNextJob` never has to reject a
  job for capacity — assert its backstop is unreachable in a full-pipeline run.

**Unit — API guards**
- `PATCH` and `DELETE` return 409 for every non-`CREATED` stage, parameterised
  over all stages so a future stage cannot silently become editable.
- `DELETE` cascades: stage runs, artifacts, events, approvals and jobs are gone.
- `POST /api/tasks` with `start: true` and `false` produces the two documented
  states, and `start: true` with no free slot returns 409 while still creating
  the task.

**Unit — scheduling**
- Three eligible jobs with differing priority: highest priority claimed first.
- Equal priority, differing difficulty: `S` before `M` before `L`.
- Equal priority, `NULL` difficulty sorts with `M`, then FIFO by `created_at`.

**Component**
- The menu trigger is not a descendant of the title anchor.
- Clicking the title navigates; clicking anywhere else on the card does not.
- Escape closes the menu and returns focus to the trigger.
- Choosing Start twice quickly issues one request.
- An open menu survives an `AutoRefresh` tick.
- A disabled Start renders the reason and names the blocking task.

**Manual**
- Queue four tasks, start one, confirm the other three show Start disabled with
  the reason. Cancel the running one, confirm Start re-enables within one
  refresh tick.
- Take a task to `PLAN_GATE`, confirm Start is now **enabled** for another
  `CREATED` card, and starting it lets both sit on the board at once — one
  `awaiting_gate`, one genuinely `running`. Approve the gate; confirm it either
  resumes (slot free) or is refused with a `CapacityError` naming the running
  task (slot taken), and no second task ever showed a false running dot.

---

## 13. Open questions

1. ~~**Should gated tasks release their slot?**~~ **Settled: yes**, unconditionally
   — see §8.4. Waiting on approvals blocking all other work proved too costly
   in practice, so there is no `gatesHoldSlot` toggle; releasing the slot is
   simply the behavior now, kept honest by admission-checking the gate's
   resume rather than by holding the slot.
2. **Delete beyond `CREATED`.** Finished tasks accumulate on the board forever.
   Deleting them needs workspace cleanup (§7.2) and loses the cost history that
   feeds `/usage`. An **Archive** flag that hides a task from the board while
   keeping its rows is probably the better answer — separate spec.
3. **Editing a failed task before retry.** Today `retry` re-runs the same stage
   with the same inputs. Being able to fix the description and restart from
   `CREATED` would be useful, but "restart" is a different operation from
   "retry" and needs its own state-machine signal.
4. **Manual queue ordering.** If priority proves too coarse for choosing what to
   start next, the Created column could gain drag-to-reorder. That means a
   persisted `queue_position` column and a reorder endpoint — a materially
   bigger feature, and probably unnecessary while the user starts tasks by hand.
