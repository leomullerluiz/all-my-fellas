# Human in the Loop — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Give the human at a gate something to do other than approve or
> destroy. Adds `request_changes` to the two gates that lack it, lets an
> approval carry an edit, makes a finished task reusable, and gives the
> reviewer a way to fix one line by hand instead of spending a rework cycle.
> **Prerequisite:** the pipeline as built. `spec-retry-recovery.md` should land
> first: §5 here (restart from a chosen stage) is the general case of the
> mechanism that spec builds for the specific one, and duplicating that
> machinery twice would be a mistake.
> **Related:** `spec-code-review.md` (§6.2 introduced the third decision kind
> and §6.3 the comment-as-artifact channel this spec extends to two more gates;
> §15.4 left the budget question open and §3.4 here answers it);
> `spec-task-queue.md` (§6 — editing is `CREATED`-only, which §4 and §5 relax
> under stated conditions; §8.2 — every re-admission is capacity-checked);
> `spec-retry-recovery.md` (§4 — the terminal-cause record §5 reuses);
> `spec-audit-trail.md` (§5 — artifact versions, which §4 writes a human
> version into); `spec-agent-context.md` (§3 — what reaches the Developer's
> prompt on a rework cycle, which §4.3 depends on being fixed).

---

## 1. Summary

The pipeline has three human gates. At two of them, the only way to disagree is
to destroy the task.

`GATE_ALLOWED_DECISIONS` (`stages.ts:178-182`) reads:

```ts
PLAN_GATE:         ["approve", "reject"],
HUMAN_CODE_REVIEW: ["approve", "request_changes", "reject"],
STAKEHOLDER_GATE:  ["approve", "reject"],
```

`reject` produces terminal `REJECTED` (`state-machine.ts:154-156`). A `REJECTED`
task cannot be retried — `retryTask` requires `status === "failed"`
(`orchestrator.ts:737-739`). It cannot be edited or deleted — both require
`currentStage === "CREATED"` (`orchestrator.ts:459-463`, `:533-537`). It is a
dead row that keeps the brief, the stories, the plan, the clone and the branch
that were paid for, and offers no way to use any of them.

So the single most common outcome of a real technical review — *"the plan is
eighty percent right; redo the approach to the third section"* — has no path
through this product. The user's options are to approve a plan they disagree
with, or to throw away everything and retype the task.

Five changes, plus one new gate:

| § | Change | Replaces today's |
|---|---|---|
| 3 | `request_changes` on `PLAN_GATE` and `STAKEHOLDER_GATE` | approve-or-destroy |
| 4 | Approve **with** an edited artifact | a comment nobody reads |
| 5 | Restart from a chosen stage | retype the task |
| 6 | Duplicate a task | retype the task |
| 7 | Fix by hand in the workspace | a full rework cycle for one line |
| 8 | A clarification gate on `## Open Questions` | assumptions discovered at delivery |

---

## 2. Scope

**In scope**

- Widening `GATE_ALLOWED_DECISIONS` and the transitions behind it (§3).
- A human-authored artifact version, written at an approving gate (§4).
- A `restart_from` signal in the state machine, with guards (§5).
- Task duplication, including what is and is not copied (§6).
- Workspace affordances at the review gate: path, editor link, patch download,
  and a commit action (§7).
- A `CLARIFICATION_GATE` that auto-skips when there is nothing to ask (§8).

**Out of scope**

- Line-level comments on the diff. `spec-code-review.md` §15.2 already scoped
  this as a separate feature of comparable size, and §7.5 here argues the host's
  own PR review UI is the better place for it.
- Editing a task's title, description or repository after it has started.
  §5.6 explains why restart-from-a-stage is the right shape for that need and a
  live edit is not.
- Multi-user attribution of decisions. `approvals` records the decision, not who
  made it, and nothing else in the product models a second user.
- Reopening a `COMPLETED` task from pull-request feedback.
  `spec-delivery-lifecycle.md` §5 owns it; the artifact channel it uses is the
  one §4 here generalises.

---

## 3. `request_changes` at every gate

### 3.1 What already generalises

Most of this is already gate-agnostic, which is why the change is small:

- **The button renders itself.** `GatePanel` reads
  `GATE_ALLOWED_DECISIONS[gate]` and derives `canRequestChanges`
  (`task-actions.tsx:70-71`), rendering the button conditionally at `:141-148`.
  Adding the decision to the map makes the button appear with no component
  change.
- **The comment requirement is already enforced twice.** Client-side at
  `task-actions.tsx:74-80`, server-side in `gateDecisionSchema`
  (`validation/schemas.ts:62-75`) and again in `decideGate`
  (`orchestrator.ts:619-624`). None of the three is gate-specific.
- **The comment already becomes an artifact.** `decideGate` writes a
  `human_review` artifact on the `request_changes` branch
  (`orchestrator.ts:619-637`), keyed to the last stage run, with no reference to
  which gate produced it.
- **The API already validates the decision against the gate.** Both
  `decideGate` (`orchestrator.ts:604-606`) and `nextTransition`
  (`state-machine.ts:151-153`) check `GATE_ALLOWED_DECISIONS`, so the rejection
  of an invalid pairing survives the widening.

What is genuinely new is the routing.

### 3.2 Where each gate's `request_changes` goes

`state-machine.ts:157-159` sends every `request_changes` to `reworkOrFail`,
which returns work to `DEVELOPMENT`. That is right for `HUMAN_CODE_REVIEW` and
wrong for the other two, because at those gates there is no code to rework.

| Gate | Artifact under review | `request_changes` re-runs |
|---|---|---|
| `PLAN_GATE` | `techplan.md` (Architect) | `ARCHITECTURE` |
| `HUMAN_CODE_REVIEW` | the diff (Developer) | `DEVELOPMENT` — unchanged |
| `STAKEHOLDER_GATE` | `homolog_report.md`, the finished branch | `DEVELOPMENT` |

`STAKEHOLDER_GATE` routes to `DEVELOPMENT` rather than to homologation: a
stakeholder rejecting at the delivery gate is rejecting the *work*, and
re-running the PO's acceptance check against unchanged code would produce the
same report. If the disagreement is about scope rather than implementation, the
right move is §5's restart from `PO_REFINEMENT`, not a rework cycle.

The state machine's gate switch (`state-machine.ts:164-179`) is already
exhaustive over `Gate` with a `never` check — the comment above it at `:164-166`
records that a ternary here previously caused a real routing bug. The
`request_changes` branch above it becomes a second exhaustive switch of the same
shape, rather than the single `reworkOrFail` call it is today.

### 3.3 The Architect's rework input

Sending work back to `ARCHITECTURE` only helps if the Architect learns why. It
gets the `human_review` artifact through the mechanism §4.3 fixes — and it needs
`roles.ts` to say so.

Today `ARCHITECTURE.consumes` is `["brief", "stories"]` (`roles.ts:66`), and the
rework supplement in `gatherInputs` is hard-coded to `stage === "DEVELOPMENT"`
(`execute.ts:105-110`). That condition becomes a role property:

```ts
/** Artifact types appended on a rework cycle (attempt > 1), newest version of each. */
reworkInputs: ArtifactType[];
```

- `DEVELOPMENT`: `["code_review_report", "qa_report", "human_review"]` — exactly
  today's hard-coded list, now declared where the other input rules live.
- `ARCHITECTURE`: `["human_review"]`.
- Everything else: `[]`.

This removes a stage name from `execute.ts` and puts the rule in `roles.ts`,
which is where `consumes` and `produces` already live.

### 3.4 The rework budget, and the question `spec-code-review.md` left open

`reworkOrFail` counts `DEVELOPMENT` attempts against `reworkMaxCycles`
(`state-machine.ts:106-122`, fed by `countStageRuns(task.id, "DEVELOPMENT")` at
`orchestrator.ts:71`). An `ARCHITECTURE` rework increments no counter and is
therefore unbounded — a user could bounce the plan back indefinitely.

That is the correct behaviour, and it should be stated rather than fixed:

- The budget exists to stop **agents** looping against each other. Its input is
  a machine verdict.
- A human pressing "request changes" on a plan is not a loop; it is the review
  the gate exists for. Every iteration is a deliberate, manually initiated
  decision by the person paying for it.

`spec-code-review.md` §15.4 asked the adjacent question — whether a human
`request_changes` should grant a cycle beyond an exhausted budget. This spec
answers it consistently: **a human decision is never refused by the budget.**
`HUMAN_CODE_REVIEW`'s `request_changes` grants one cycle past the ceiling when
the budget is spent, and the gate panel shows the count so the choice is
informed rather than surprising:

> Rework cycles used: 2 of 2. Requesting changes grants one more.

The grant is recorded on the task, using the same column
`spec-retry-recovery.md` §6 introduces for the same purpose. If both specs land,
they share one field; if only one lands, it carries its own.

### 3.5 What the gate copy has to change

`GATE_COPY` (`task-actions.tsx:17-42`) has one entry per gate with an `approve`
label and a toast. It gains a `requestChanges` description per gate, because the
consequence differs and a generic "sends the work back to the Developer" would
be wrong at `PLAN_GATE`:

- `PLAN_GATE` — "Sends the plan back to the Architect with your comment. The
  brief and the stories are kept."
- `STAKEHOLDER_GATE` — "Sends the work back to the Developer with your comment.
  Code review and QA will run again."

---

## 4. Approving with an edit

### 4.1 The dead comment box

`GatePanel` renders a comment textarea on every gate
(`task-actions.tsx:124-134`), with placeholder text promising it is "recorded
with the decision". On an `approve` at `PLAN_GATE`, it is recorded and read by
nobody:

1. `decideGate` writes the `human_review` artifact **only** inside
   `if (input.decision === "request_changes")` (`orchestrator.ts:619`). An
   approving comment reaches the `approvals` row and stops there.
2. Even if it were written, the Developer would not see it. `gatherInputs`
   appends the rework artifacts only when `attempt > 1` (`execute.ts:105`), and
   the `DEVELOPMENT` run scheduled by an approved `PLAN_GATE` is attempt 1.

So the single most natural review action — *"approved, but use the existing
`retry` helper instead of writing a new one"* — is silently discarded at the
exact moment the user is most likely to try it.

### 4.2 Two fixes, one small and one right

**Small:** persist the approving comment as a `human_review` artifact too, and
make the rework-input condition `attempt > 1 || a human_review exists since the
last run of this stage`.

**Right:** let the reviewer edit the artifact they are approving.

The small fix is worth doing on its own and is Phase A. The right fix is what
turns a gate from a signature into a review.

### 4.3 Editing the artifact at the gate

At `PLAN_GATE` the reviewer sees `techplan.md`. The gate panel gains an "Edit
plan" affordance that opens the markdown in a textarea, pre-filled with the
current content. On approve, if the text differs from what the Architect
produced, a **new artifact row of the same type** is written before the
transition:

```
artifacts
  id          art_…
  task_id     task_…
  stage_run_id  <the ARCHITECTURE run the reviewer was looking at>
  type        techplan
  content_md  <the edited markdown>
```

`latestArtifact` orders by `created_at desc` (`service.ts:495-505`), so the
Developer's `gatherInputs` picks up the human version with no change at all —
this is the property that makes the design cheap.

Three consequences to state plainly:

- **The edit must pass `validateArtifact`** (`artifacts.ts:114-137`). A reviewer
  who deletes a required `##` section would otherwise poison the next stage. The
  gate rejects the save with the same problem list the agent would get, shown
  inline.
- **`stage_run_id` is NOT NULL** (`schema.ts:116-118`), which is why the human
  version hangs off the run being reviewed — the same reasoning
  `decideGate` already records for `human_review` at `orchestrator.ts:626-630`.
- **The provenance must be visible.** Without a marker, a human edit is
  indistinguishable from agent output in the artifact tabs and in
  `spec-audit-trail.md`'s version history. §4.4 covers it.

### 4.4 Marking authorship

A nullable column on `artifacts`, appended to `MIGRATIONS` in `migrations.ts`
with `addColumn` (`migrations.ts:28-37`):

```ts
addColumn(sqlite, "artifacts", "authored_by", "TEXT");  -- NULL = agent, 'human'
```

Nullable and defaulting to NULL means every existing row keeps its meaning and
no backfill is needed. The artifact tab renders a badge for a human-authored
version, and `spec-audit-trail.md`'s version switcher labels it.

This is deliberately not a general "who" field. Nothing else in the product
models a user, and inventing an identity here would be the first half of an
auth system nobody asked for.

### 4.5 Which gates get the editor

`PLAN_GATE` only, in this spec.

- `HUMAN_CODE_REVIEW` reviews a **diff**, not a markdown document. Editing code
  at that gate is §7's job and has entirely different mechanics.
- `STAKEHOLDER_GATE` reviews `homolog_report.md`, which is a record of what
  happened. Editing a report to say something different is falsification, not
  review.

---

## 5. Restart from a chosen stage

### 5.1 The gap

Retry re-runs the last failed run with byte-identical inputs. When the mistake
is upstream — a vague description that produced a thin brief, a plan approved
and immediately regretted — there is no move at all: `editTask` and
`deleteCreatedTask` both refuse past `CREATED`
(`orchestrator.ts:459-463`, `:533-537`), and `retryTask` refuses anything that
is not `failed` (`:737-739`).

`spec-task-queue.md:603` already flagged that this needs its own signal in the
state machine rather than being bolted onto retry.

### 5.2 The signal

```ts
| { kind: "restart_from"; stage: AgentStage }
```

`nextTransition` handles it before the stage-specific branches and returns
`{ type: "run", stage: signal.stage, attempt: countStageRuns(stage) + 1 }`.
`scheduleStage` (`orchestrator.ts:87-98`) already derives the attempt number
from the run count rather than the transition, so the unique index on
`(task_id, stage, attempt)` (`schema.ts:101-105`) is satisfied without special
handling — the same property that made rework cycles work.

### 5.3 What restart does not delete

Nothing. Artifacts from the abandoned branch of history stay in the table.

This matters because `latestArtifact` takes the newest of a type
(`service.ts:495-505`), so a restart from `PO_REFINEMENT` produces a new
`stories` artifact that supersedes the old one for every downstream consumer,
while the old one remains for the audit trail. Deleting would be both
destructive and unnecessary.

The one artifact type that needs thought is `human_review`: a stale "requested
changes" comment from before the restart would be picked up by the next
`DEVELOPMENT` rework and read as current. §5.4 handles it.

### 5.4 The restart boundary

A restart records a marker event, and `gatherInputs` ignores rework artifacts
created before the most recent restart. Concretely: the `restart_from` event's
`seq` is the boundary, and the rework-input lookup filters on
`created_at >= <restart timestamp>`.

This is the same class of bug `spec-retry-recovery.md` §8 catalogues — a lookup
that scans a table for "the latest X" without asking "latest since when" — and
it is worth fixing in both places with the same shape of guard.

### 5.5 Guards

Restart is a re-admission and is capacity-checked inside its own transaction,
the shape `startTask` and `retryTask` already use (`orchestrator.ts:245-253`,
`:733-764`).

Refused when:

- The task is `running` — the worker holds a job for it. Cancel first, or wait.
  Restarting under a live stage would produce two concurrent runs of the same
  task, which `claimNextJob` prevents at the job level (`queue.ts:98`) but which
  would still leave an orphaned stage run.
- The target stage is not an `AgentStage`. Restarting into a gate or a terminal
  stage is meaningless; `DELIVERY` is excluded because it is not an agent stage
  and re-running it is what `retryTask` already does.
- The task is `COMPLETED` — that is `spec-delivery-lifecycle.md` §5's territory,
  and it has a different shape (the PR already exists and must be updated, not
  reopened).

Allowed from `failed`, `rejected`, `cancelled`, and from any gate.

### 5.6 Why not just allow editing a started task

Because the artifacts are already downstream of the description. Editing the
description of a task that is at `CODE_REVIEW` would leave a brief, stories and
a plan derived from text that no longer exists, and every later reader — human
or agent — would be looking at a document that contradicts its own source.

Restart-from-a-stage makes the consequence explicit: change the description
*and* re-run from `STAKEHOLDER_REFINEMENT`, and the chain is rebuilt. So the
edit restriction is relaxed exactly this far: **the description and title become
editable when a restart is requested**, in the same action, and only for stages
at or before the restart point. The form shown is the existing `NewTaskForm` in
`edit` mode.

---

## 6. Duplicating a task

### 6.1 Why this is the cheapest item in the spec

Nothing in the product creates a task from a task. A rejected task, a completed
task worth repeating against a second repository, a task that was 90% right —
all of them mean retyping the title, the description, the priority, the
prerequisites, and re-uploading the attachments.

The prefill machinery already exists and is already used: `NewTaskForm` accepts
`initial?: Partial<TaskFormValues>` (`new-task-form.tsx:46`) and the edit page
fills every field of it (`tasks/[id]/edit/page.tsx:37-52`), attachments and
dependencies included. A duplicate route is the same page with a different
source task and `mode="create"`.

### 6.2 What is copied

| Copied | Not copied |
|---|---|
| `repoId`, `title` (prefixed "Copy of "), `description`, `priority` | `status`, `currentStage` — the new task starts at `CREATED` |
| `requireHumanCodeReview` | `branchName`, `workspacePath`, `prUrl` |
| `dependsOn` | `difficulty`, `criticality` — the Architect re-estimates |
| Attachments, as new rows with copied bytes | Artifacts, stage runs, approvals, events, transcripts |

Attachments are copied rather than shared: they are BLOBs on the row
(`schema.ts:145`) with an `ON DELETE CASCADE` to the task, so sharing would mean
deleting one task destroys the other's files.

The estimate columns are deliberately dropped. A copied task is a new task; an
inherited `difficulty` would affect its queue ranking
(`orchestrator.ts:268-272`, `queue.ts:25-26`) based on an assessment of
different work.

### 6.3 Surface

A "Duplicate" item in the task card menu (`task-card-menu.tsx`) and on the detail
page controls, available in **every** status — including `completed` and
`rejected`, which is the case that matters most. It routes to
`/tasks/new?from=<taskId>`, and the page loads the source task through the same
`listAttachments`/`listDependencies` calls the edit page already makes.

Because it lands on the form rather than creating a row directly, a duplicate
that the user abandons costs nothing — which is the right default for an action
that will often be a starting point rather than an end.

---

## 7. Fixing by hand in the workspace

### 7.1 The gap, and the silent data loss

At `HUMAN_CODE_REVIEW` the reviewer has three options: approve, request changes,
reject. There is no *"the agent got to 95%, let me fix this one line."*

Worse, a user who finds the workspace on disk and edits it **loses the work
without being told**:

- `commitPendingChanges` (`workspace.ts:170-180`) only runs inside the
  `DEVELOPMENT` stage (`execute.ts:272-282`), so nothing commits edits made
  while the task sits at a gate.
- `pushBranch` (`workspace.ts:183-201`) pushes `branchName:branchName`, which is
  committed HEAD. Uncommitted edits are not in it.
- The task then reaches `COMPLETED`, and `executeCleanup`
  (`execute.ts:404-412`) deletes the directory after the retention window,
  taking the edits with it.

The user's changes are visible in the diff viewer the whole time — because
`readDiffIndex` runs `git diff origin/base...HEAD` (`diff.ts:151-152`), which
does *not* include the working tree — no, in fact they are **not** visible even
there. They exist only on disk, and then they do not.

### 7.2 What to add at the review gate

Four affordances, in ascending order of ambition:

1. **Show the path.** `task.workspacePath` is on the row and rendered nowhere.
   Displaying it, with a copy button, is one line and turns an undiscoverable
   directory into a documented one.
2. **Open in an editor.** A `vscode://file/<absolute path>` link. It is a
   local-first single-user product; the editor is on the same machine by
   definition.
3. **Download the patch.** `git diff origin/<base>...HEAD` as a `.patch`
   attachment, reusing `diffAgainstBase` (`workspace.ts:126-136`). Useful for
   review outside the browser and for applying the change elsewhere.
4. **Commit my edits.** A button that calls the existing `commitPendingChanges`
   with a message naming the human as author, appends a `git` event, and
   refreshes the diff.

### 7.3 The dirty-tree warning

Independent of whether the user ever presses (4), the gate must **detect** an
uncommitted working tree and say so. `simpleGit(path).status()` is already used
inside `commitPendingChanges` (`workspace.ts:175`); calling `isClean()` when
rendering the review page costs one git invocation.

If the tree is dirty, the gate panel shows a warning above the decision buttons:

> This workspace has uncommitted changes. They are **not** part of the diff
> below and will **not** be delivered. Commit them, or discard them.

This is the highest-value line in §7 and it is nearly free. Silent data loss is
the worst failure mode in the product, and today it is the default.

### 7.4 Attribution of the commit

The commit uses the configured git identity (`resolveGitIdentity`,
`env.ts:118-123`), the same one every pipeline commit uses. Two options were
considered — a distinct "human edit" identity, or a `Co-authored-by` trailer.
Neither is worth it: the message text (`"fix: manual edit at code review"`) says
what happened, and the product has no user identity to attribute to (§2, out of
scope).

### 7.5 Why not inline comments instead

The obvious alternative is line-level commenting on the diff, feeding back to
the Developer. `spec-code-review.md` §15.2 sized that as a feature of comparable
scale to that whole spec: a `review_comments` table keyed by file and line, a
threading model, and prompt rendering.

The judgement here is that it should not be built at all, because the product
**already opens a pull request**, and the host's inline review UI is better than
anything this codebase would produce and costs nothing. The two things the host
cannot do are (a) show line numbers in this viewer, which is a small change to
`diff-viewer.tsx`, and (b) commit an edit from the workspace before the PR
exists, which is §7.2 item 4. Those two, plus
`spec-delivery-lifecycle.md` §5's "reopen from PR feedback", deliver more than
the table would.

---

## 8. The clarification gate

### 8.1 A required section nobody can answer

`brief.md` requires a `## Open Questions` section — it is in
`ARTIFACT_SPECS.brief.requiredSections` (`artifacts.ts:33-41`) — and
`prompts/stakeholder.md:15-16` instructs the agent:

> List the questions whose answers would change the scope. Do not invent
> answers — record the question and the assumption you are proceeding with.

The agent complies. The assumptions then flow into `stories.md`, become
acceptance criteria, get implemented, get verified against those same
acceptance criteria by QA, and first reach a human at the delivery gate — by
which point six agent stages have been paid for on a premise the user was never
asked about.

The section is a required part of the very first artifact, and the product
provides no way to respond to it. That is the definition of a gate that is
missing.

### 8.2 Placement

```
STAKEHOLDER_REFINEMENT   agent · brief.md
     └─► CLARIFICATION_GATE   human · answer or accept the assumptions   ← NEW
          └─► PO_REFINEMENT   agent · stories.md
```

Immediately after the brief, before any repository is cloned. This is the
cheapest point in the pipeline to change direction: one agent session has run,
`PO_REFINEMENT` is the first stage with `needsWorkspace: true`
(`roles.ts:57`), and nothing has been written to disk.

### 8.3 Auto-skip is the default path

A gate that fires on every task would add a mandatory interruption to the
product's fastest stage and would be switched off within a week.

`extractOpenQuestions(brief)` parses the `## Open Questions` section using the
same tolerant section reader `extractPlanEstimate` already relies on
(`artifacts.ts:152-156`). If the section contains only `None.` — which
`buildSystemPrompt` explicitly instructs agents to write for an empty section
(`prompt.ts:83-84`) — or no list items, the gate is skipped and the pipeline
proceeds to `PO_REFINEMENT` with no human involvement.

This means the gate is *self-limiting*: it appears exactly when the Stakeholder
agent itself judged that something material was unclear.

### 8.4 The decision

Two decisions, not three:

```ts
CLARIFICATION_GATE: ["approve", "request_changes"],
```

- **`approve`** — accept the assumptions as written. The pipeline continues
  unchanged. This is one click and must stay one click, or §8.3's self-limiting
  property is wasted.
- **`request_changes`** — the answers, in the comment. Re-runs
  `STAKEHOLDER_REFINEMENT` with the answers as a `human_review` rework input
  (§3.3's `reworkInputs`, with `STAKEHOLDER_REFINEMENT: ["human_review"]`), so
  the brief is rewritten with real answers instead of assumptions.

No `reject`: a task the user does not want at this point has cost one cheap
agent session and can be cancelled. Adding a terminal decision here would create
another `REJECTED` dead end of exactly the kind this spec exists to remove.

### 8.5 The panel

Unlike the other gates, this one renders **structured** content: the parsed
questions, each with the assumption the agent adopted, and a textarea per
question rather than one comment box. The answers are assembled into the
`human_review` markdown on submit.

This is the one place in the product where a gate has something better to show
than a document, and rendering it as a plain markdown blob would waste the
structure the artifact contract already guarantees.

### 8.6 Settings

`clarificationGate: "auto" | "off"`, defaulting to `"auto"` (the §8.3
behaviour). `"off"` skips it unconditionally, for users who would rather answer
at the plan gate.

There is no `"always"` mode. A gate that fires when the agent has no questions
would be showing an empty form.

---

## 9. Data model summary

New columns, one appended `MIGRATIONS` entry using `addColumn`
(`migrations.ts:28-37`):

```ts
{
  name: "human-authored artifacts and granted rework cycles",
  up: (sqlite) => {
    addColumn(sqlite, "artifacts", "authored_by", "TEXT");
    addColumn(sqlite, "tasks", "granted_rework_cycles", "INTEGER NOT NULL DEFAULT 0");
  },
}
```

`granted_rework_cycles` is shared with `spec-retry-recovery.md` §6 — whichever
lands first adds it, and the other reads it. Two columns for one concept would
be worse than one column with two writers.

No new tables. `CLARIFICATION_GATE` is a new member of `STAGES`, `GATES`,
`BOARD_STAGES` and `STAGE_LABELS` (`stages.ts`), all of which are TypeScript
constants; `tasks.current_stage` is a plain `TEXT` column with no CHECK
constraint (`bootstrap.sql.ts:29`), so no migration is required for the stage
itself.

`statusForStage` (`stages.ts:103-123`) derives `awaiting_gate` from `isGate`
rather than an enumerated list — the comment at `:104-107` records that this was
changed *because* a previously added gate silently reported "running". The new
gate therefore needs no change there, which is the property that comment was
written to protect.

---

## 10. Test plan

**State machine (pure, no DB)**
- `PLAN_GATE` + `request_changes` → `run ARCHITECTURE`, not `DEVELOPMENT`.
- `STAKEHOLDER_GATE` + `request_changes` → `run DEVELOPMENT`.
- `HUMAN_CODE_REVIEW` + `request_changes` → `run DEVELOPMENT`, unchanged.
- **Regression:** `approve` on all three gates still routes exactly as
  `spec-code-review.md` §13 asserts, after the switch is duplicated for the
  `request_changes` branch.
- `CLARIFICATION_GATE` + `approve` → `run PO_REFINEMENT`; + `request_changes` →
  `run STAKEHOLDER_REFINEMENT`; + `reject` → throws `InvalidGateDecisionError`.
- `restart_from` returns the requested stage with the next attempt number,
  parameterised over every `AgentStage`.
- `restart_from` a gate or a terminal stage throws.
- An `ARCHITECTURE` rework does not consume the `DEVELOPMENT` budget: after N
  plan rejections, `developmentAttempts` is unchanged.

**Artifacts**
- A human-edited `techplan` that omits a required section is rejected with the
  same problem list `validateArtifact` produces for an agent.
- `latestArtifact` returns the human version when it is newer, with no change to
  its query.
- `extractOpenQuestions` returns empty for `None.`, for an absent section, and
  for a section with prose but no list items; non-empty for a real list.
  Parameterised over the same bold/list-marker variations
  `tests/artifacts.test.ts` already exercises for `readField`.

**Orchestrator (temp DB)**
- An approving comment at `PLAN_GATE` produces a `human_review` artifact and the
  next `DEVELOPMENT` run receives it at attempt 1. **This test fails today.**
- Duplicating a task copies attachment bytes into new rows; deleting the source
  leaves the copy's attachments intact.
- Duplicating drops `difficulty`/`criticality` and starts at `CREATED`.
- `restart_from` on a `running` task is refused.
- A rework artifact created before a restart is not picked up after it.
- A human `request_changes` at `HUMAN_CODE_REVIEW` with the budget exhausted
  grants one cycle rather than failing the task.

**Workspace**
- The review page reports a dirty working tree; a clean one shows no warning.
- "Commit my edits" produces a commit and the diff index then includes the file.

**Component**
- `GatePanel` renders the "Request changes" button for all four gates once
  `GATE_ALLOWED_DECISIONS` includes the decision, with no component change —
  assert by driving the existing component with each gate.
- The clarification panel renders one textarea per parsed question.

---

## 11. Phasing

**Phase A — the dead comment (§4.2, small fix).** Persist an approving comment
as a `human_review` artifact and make the Developer receive it on attempt 1.
Two conditions changed, no schema, no UI. It fixes a silent data loss that
exists today and is worth shipping alone.

**Phase B — `request_changes` on the two gates (§3).** One map entry per gate,
one switch in the state machine, the `reworkInputs` move, and the gate copy.
No schema change. This is the item that removes the approve-or-destroy trap.

**Phase C — duplicate (§6).** Independent of everything else, mostly routing,
and the cheapest way to make `REJECTED` and `COMPLETED` tasks useful again.

**Phase D — the workspace affordances (§7).** The dirty-tree warning first, on
its own, because it stops the data loss; the editor link, patch download and
commit action after.

**Phase E — restart from a stage (§5).** Depends on `spec-retry-recovery.md`'s
terminal-cause record and on the restart-boundary guard, so it lands last among
the recovery items.

**Phase F — the clarification gate (§8).** Genuinely new pipeline surface: a
stage, a parser, a structured panel and a setting. Independently valuable, but
the most speculative item here (§12.1).

---

## 12. Open questions

1. **Is the clarification gate worth its interruption?** §8.3's auto-skip is
   what makes it defensible, and it rests entirely on the Stakeholder agent
   being honest about having questions. If the agent writes `None.` to avoid
   friction — which is exactly what a model optimising for a smooth run would do
   — the gate never fires and the section stays decorative. The measurement is
   cheap: log how often the section is non-empty before building the gate.
2. **Should `STAKEHOLDER_GATE`'s `request_changes` route to `DEVELOPMENT` or
   offer a choice?** §3.2 routes to `DEVELOPMENT`, but a stakeholder rejecting a
   finished feature is often rejecting the *scope*, which means
   `PO_REFINEMENT`. Offering both at the gate is more honest than guessing, and
   is nearly free once §5's `restart_from` exists — at which point
   `request_changes` at that gate may be redundant with it.
3. **Does an editable `techplan` undermine the Architect?** A reviewer who
   rewrites the plan rather than requesting changes gets a Developer that follows
   the human's plan with none of the repository exploration behind it. The
   counter-argument is that the reviewer is the one accountable for the result.
   A middle option — the edit is allowed but always re-runs `ARCHITECTURE` with
   the edit as input — is more expensive and possibly more correct.
4. **Should `human_review` be split by gate?** One artifact type currently
   carries the Developer's feedback, and §3.3 adds the Architect's and §8.4 adds
   the Stakeholder's answers. They are all "what a human said", but they are
   consumed by different roles, and a single type means a stale one can be
   picked up by the wrong reader — §5.4's boundary guard exists precisely because
   of this. Separate types (`plan_feedback`, `code_feedback`, `clarification`)
   would make the guard unnecessary at the cost of three near-identical specs in
   `ARTIFACT_SPECS`.
5. **Unbounded plan rework (§3.4).** Argued as correct because a human drives
   every iteration. It is still unbounded spend with no ceiling, and it becomes
   safe only once `spec-spend-and-operational-control.md` §5's per-task ceiling
   exists. Until then, the gate panel showing cumulative task cost beside the
   button is the cheapest mitigation.
6. **Does duplicate need to copy attachments by default?** Copying BLOBs
   silently multiplies database size, and the common case may be a duplicate
   that wants the description but not the 4 MB screenshot. A checkbox on the
   duplicate action is trivial; guessing wrong in either direction is not
   obviously worse than the other.

---

## 13. No-approval automation (implemented)

Unlike the rest of this document, this section describes shipped behaviour:
an instance-wide `settings.noApprovalAutomation` switch (default `false`) that
lets a task run from creation to a delivered PR with **zero** human gates.

- **Scope.** A single global boolean, consistent with the rest of `settings`
  (a one-row blob, no user/team model — see §2's existing "no multi-user
  attribution" note). There is no per-project or per-task override.
- **What it bypasses.** With the switch on, `ARCHITECTURE` success runs
  `DEVELOPMENT` directly instead of parking on `PLAN_GATE`, and an accepted
  `PO_HOMOLOGATION` verdict runs `DELIVERY` directly instead of parking on
  `STAKEHOLDER_GATE` — regardless of `criticality`, which otherwise only
  waives `PLAN_GATE` via `autoApprovePlanForLowCriticality`.
- **What it does not bypass.** The `PO_HOMOLOGATION` escalation branch
  (a second rejection, or a rejection with the rework budget exhausted) still
  parks on `STAKEHOLDER_GATE`: an ambiguous double-rejection needs a human
  regardless of how much the operator trusts the automation. `HUMAN_CODE_REVIEW`
  is also untouched — it is a separate, per-task opt-in (`requireHumanCodeReview`)
  that this global switch does not override.
- **Audit trail.** Each bypass appends a `gate_bypassed` event (naming the
  skipped gate) through the same `appendEvent` channel every other pipeline
  event uses; no row is ever written to `approvals` for a gate that was
  bypassed rather than decided. The silent `autoApprovePlanForLowCriticality`
  waiver is unaffected and remains unaudited, as it always has been — the two
  skip reasons are deliberately distinguishable after the fact.
- **UI.** Settings renders the toggle next to "Automatic plan gate" in
  "Pipeline limits", alongside an always-visible red warning (not hidden until
  the operator opts in) stating that enabling it skips both plan review and
  final PR approval for every task.
