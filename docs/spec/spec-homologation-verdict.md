# Homologation Verdict — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Give `PO_HOMOLOGATION` an outcome. Its verdict is parsed by a
> function nothing calls, so the stage costs a model run and changes nothing.
> **Prerequisite:** the pipeline as built, with `CODE_REVIEW` and `QA` verdicts
> already routed through `nextTransition` (`spec-code-review.md`, as shipped).
> **Related:** `spec-code-review.md` (§4.1 the fail-closed verdict rule reused
> here; §6.2 the gate decision table this spec amends; §7 the shared rework
> budget it draws on) · `spec-task-queue.md` (§8 — an escalation parks the task
> and releases its slot) · `spec-execution-honesty.md` (a verdict the pipeline
> discards is the same failure mode as an agent claiming a test run it never
> performed) · `spec-mechanical-verification.md` (homologation's evidence is
> another agent's report plus a diff summary; that ceiling decides the routing —
> this spec's §5.3) · `spec-audit-trail.md` (its §8 is where the
> `artifacts.stage_run_id` NOT NULL constraint this spec's §8.3 runs into gets
> solved) · `spec-retry-recovery.md` (a homologation rejection is deliberately
> never a failure — this spec's §5.2) · `spec-cost-forecast.md` (its §3 measures
> homologation at 2.1% of a task's spend, the whole argument of this spec's
> §5.3).

---

## 1. Summary

`extractHomologationVerdict` exists (`src/server/pipeline/artifacts.ts:195`), is
correct, is unit tested (`tests/artifacts.test.ts:157-165`), and is imported by
nothing outside those tests. `executeAgentStage` extracts a verdict for exactly
two stages (`src/server/pipeline/execute.ts:290-297`), and `nextTransition`
routes `PO_HOMOLOGATION` through the unconditional `LINEAR_SUCCESSOR` table
(`src/server/pipeline/state-machine.ts:70-76`). An agent that writes
`Verdict: rejected` produces a task that advances byte-identically to one that
writes `Verdict: accepted`.

This specification wires the verdict in and decides what a rejection means:

```
PO_HOMOLOGATION   agent · homolog-report.md
                  · models.light, maxTurns 10, tools: ["Read"]
                  · sees stories + qa-report + a diff SUMMARY, never the diff
      │
      ├─ Verdict: accepted ────────────────────────────► STAKEHOLDER_GATE
      │
      └─ anything else (fail closed)
              │
              ├─ first homologation pass AND rework budget left
              │       └─► DEVELOPMENT (attempt + 1)   shares reworkMaxCycles
              │
              └─ second homologation pass OR budget spent
                      └─► STAKEHOLDER_GATE, carrying the rejection
```

A rejection never fails the task and never loops more than once. Both follow from
one fact developed in §5.3: homologation is the least-equipped agent that ever
looks at the change, and the only one whose finding is usually about the
*specification* rather than the code.

---

## 2. Scope

**In scope**

- Extracting the verdict in `executeAgentStage` and carrying it on the
  `stage_succeeded` signal; the type question — `"accepted" | "rejected"` versus
  `ReviewVerdict` (§4).
- The routing decision, with the rejected alternatives (§5).
- `request_changes` on `STAKEHOLDER_GATE`, which a machine rejection arriving at
  a human gate makes necessary (§6).
- Feeding `homolog_report` to the Developer on a rework (§7).
- Correcting `README.md` and `prompts/homologation.md`, both of which describe
  behaviour that does not exist (§10).

**Out of scope**

- Per-criterion structured output (criterion → `met` / `not met` as data rather
  than Markdown). It would let a rework target one criterion instead of the whole
  change, and needs its own schema, parser and UI. See §13.2.
- Giving homologation the full diff or Bash. That changes what the stage costs
  and can verify — `spec-mechanical-verification.md`'s subject, not this one's.
- Any schema change. This feature deliberately requires none — §5.4, §9.
- Re-running only `QA` after a homologation rework. The full
  `DEVELOPMENT → CODE_REVIEW → QA` chain re-runs, for the reason
  `spec-code-review.md` §7 gives: new code needs a new review.
- A `homologationEnabled` setting. Making the stage optional is the wrong answer
  to "this stage does nothing"; making it do something is. See §13.3.

---

## 3. What happens today

### 3.1 The dead function

```ts
// src/server/pipeline/artifacts.ts:194-198
/** Extracts the homologation verdict; same fail-closed rule as QA. */
export function extractHomologationVerdict(report: string): "accepted" | "rejected" {
  const value = readField(report, "Verdict")?.toLowerCase() ?? "";
  return /\baccepted\b/.test(value) && !/not\s+accepted/.test(value) ? "accepted" : "rejected";
}
```

Every caller in the repository is a test. `executeAgentStage` imports
`extractPlanEstimate` and `extractReviewVerdict` and not this one
(`execute.ts:31-35`), and its post-run dispatch has three branches —
`ARCHITECTURE` (`:260`), `DEVELOPMENT` (`:272`), `QA || CODE_REVIEW` (`:290`) —
none mentioning `PO_HOMOLOGATION`. The signal is built with `reviewVerdict` left
`undefined` (`execute.ts:258`, `:307`), and `nextTransition` falls past every
explicit branch to the lookup at `state-machine.ts:206`, finds
`PO_HOMOLOGATION: "STAKEHOLDER_GATE"` (`:74`) and parks the task. The artifact
contract is fully in place — `homolog_report` requires a `## Verdict` section
(`artifacts.ts:72-76`), so a report with *no* verdict fails the stage. A report
with a *rejecting* verdict passes.

### 3.2 The two documents that mislead, in opposite directions

`README.md:271-274` states:

> The QA and homologation verdicts fail closed: anything that cannot be parsed as
> a pass is treated as a rejection.

True of the *parser* and false of the *pipeline*. `extractHomologationVerdict`
does fail closed (`artifacts.ts:195-198`), but nothing consumes its return value,
so nothing "treats" the verdict as anything — the sentence promises a consequence
that does not exist. It also omits `CODE_REVIEW`, which really does fail closed
end to end (`execute.ts:290-297`, `state-machine.ts:191-195`).

`prompts/homologation.md:32-34` is the accurate description of today's routing:

> A `rejected` verdict does not stop the pipeline on its own — the human
> stakeholder still decides — but it is the signal they will read first, so be
> direct about why.

Note what the prompt is doing: telling the model its verdict is advisory. That is
a behavioural cost, not just a documentation defect. An agent told its output does
not bind is invited to hedge, and hedging is the failure this stage can least
afford — its entire job is a binary acceptance call. Both documents change in §10.

---

## 4. The type problem

`ReviewVerdict` is `"approved" | "changes_requested"` (`state-machine.ts:19`).
`extractHomologationVerdict` returns `"accepted" | "rejected"`.

### 4.1 Why the shared field does not extend

The comment justifying one shared field is explicit (`state-machine.ts:27-29`):

> `reviewVerdict` is shared by `CODE_REVIEW` and `QA`: both produce the same
> approve / request-changes shape, and two near-identical fields would invite
> passing the wrong one.

Sound, and it does not reach homologation. It rests on two properties
`CODE_REVIEW` and `QA` share and `PO_HOMOLOGATION` does not:

1. **Identical handling.** Both reviewers' branches are the same statement:
   approved → next stage, anything else → `reworkOrFail`
   (`state-machine.ts:191-204`), so a value in the wrong field is still
   *interpreted* correctly and only the clerical hazard remains. Homologation
   routes elsewhere, under a different condition (§5). Once two stages do
   different things with a field, sharing it stops compressing the model and
   starts hiding a distinction.
2. **Identical vocabulary at the prompt boundary.** `prompts/qa.md:19-34` and the
   code reviewer's prompt both specify `approved` / `changes_requested`.
   `prompts/homologation.md:20-30` specifies `accepted` / `rejected`, rightly:
   `changes_requested` presumes the remedy is a code change, and the commonest
   true cause of a homologation rejection is that the stories asked for something
   the change does not do — a defect, or a criterion nobody could have met as
   written. "Rejected" states the outcome without asserting the remedy.

Unifying on `ReviewVerdict` buys one deleted type alias and pays with a prompt
rewrite that makes the Product Owner speak like a code reviewer. Bad trade.

### 4.2 The shape

```ts
export type ReviewVerdict = "approved" | "changes_requested";

/**
 * Verdict emitted by `PO_HOMOLOGATION`. Deliberately not a `ReviewVerdict`: a
 * review rejection is a defect report, this one is a claim that the wrong thing
 * was built, and the pipeline routes them differently.
 */
export type HomologationVerdict = "accepted" | "rejected";

| {
    kind: "stage_succeeded";
    stage: Stage;
    reviewVerdict?: ReviewVerdict;
    homologationVerdict?: HomologationVerdict;
  }
```

Two optional fields on one flat variant, not a discriminated union keyed on
`stage`. A union would be stricter and would not compile: `executeAgentStage`
builds the signal from `run.stage`, a `Stage` read from the database
(`execute.ts:307`), which TypeScript cannot narrow to a literal. Forcing it means
a `switch` over every stage at the one call site that most wants to stay generic.
The clerical hazard is contained anyway — the value sets are disjoint, so
`reviewVerdict: "rejected"` and `homologationVerdict: "approved"` are both type
errors. Only a correctly-typed value in the wrong field compiles, and §4.3 makes
that loud.

### 4.3 Fail closed in the state machine, not only in the parser

`extractHomologationVerdict` fails closed on unparseable text. Not enough: that
protects against a bad *report*, not a missing *call*, and a missing call is the
bug being fixed. So the state machine treats absence as rejection, exactly as it
already does for reviewers — `signal.reviewVerdict === "approved" ? … :
reworkOrFail` (`state-machine.ts:192`) and `signal.reviewVerdict !== "approved"`
(`:198`), covered by `tests/state-machine.test.ts:88-96` and `:130-138`. The
consequence is deliberate: if a later refactor drops the
extraction, every task rejects and the board fills with escalations. That is a
loud failure. The current design's failure — silently accepting everything — is
the one that survived long enough to be written up here.

---

## 5. Where a rejection routes

### 5.1 The candidates

| | Route | What it asserts |
|---|---|---|
| a | `reworkOrFail` → `DEVELOPMENT`, shared budget | The code is wrong and the Developer can fix it |
| b | → `PO_REFINEMENT` | The stories are wrong and must be rewritten |
| c | New human gate | A person must adjudicate, and none is scheduled |
| d | `terminal FAILED` | The task is dead |

### 5.2 The decision

**A rejection returns the work to the Developer once; any subsequent rejection
escalates to `STAKEHOLDER_GATE` with the rejection carried in front of the human.
It is never terminal.**

**(d) `FAILED` is the worst option and the easiest to reach for.** At
`PO_HOMOLOGATION` the branch has commits and has passed both code review and QA.
`FAILED` is terminal, and `applyTransition` schedules workspace cleanup on every
terminal outcome (`orchestrator.ts:115-125`, `:129-134`), so the clone is deleted
after `workspaceRetentionDays` and the branch was never pushed — `DELIVERY` is
downstream of the gate. Destroying verified work on the say-so of the pipeline's
cheapest agent is indefensible, and it is worse than merely hard to undo: it is
**unreachable by `retryTask` at all**. A homologation-driven `terminal FAILED`
leaves the `PO_HOMOLOGATION` run at status `done` — the stage succeeded, the
state machine failed the task — so `retryTask`'s
`listStageRuns(taskId).filter(run => run.status === "failed").at(-1)`
(`orchestrator.ts:741-746`) finds nothing and throws
`GateError("No failed stage was found to retry.")`. Even if it did fire, it
would re-run homologation on unchanged inputs for the same verdict.

**(b) `PO_REFINEMENT` is the diagnostically correct answer and the operationally
wrong one.** A homologation failure genuinely is, more often than not, an
acceptance-criteria mismatch. But rewriting `stories.md` mid-flight invalidates
everything downstream: the `techplan.md` a human approved at `PLAN_GATE` was
approved against the old stories, the code was written against them, QA verified
against them — the state machine would re-open a gate the user already cleared.
And nothing makes the second pass different: the Product Owner is handed the same
brief with no signal about what homologation objected to. Re-specification is a
human decision, and §6 offers it to a human.

**(c) A new human gate is redundant.** The stage after `PO_HOMOLOGATION` is
already `STAKEHOLDER_GATE`. Stopping for a human one step before a gate that
already stops for a human is ceremony: another `GATES` member (`stages.ts:62-66`),
another `GATE_ALLOWED_DECISIONS` row, another `GATE_COPY` entry
(`task-actions.tsx:17-42`), another `STAGE_LABELS` entry and another
`BOARD_STAGES` column. It would *not* need a `statusForStage` case —
`statusForStage` derives `awaiting_gate` from `GATES` rather than enumerating
gates, precisely so a new one cannot silently report "running"
(`stages.ts:103-107`) — but everything else is real. Escalating *to the gate that
exists* gets the same outcome for no new pipeline shape.

**(a) `DEVELOPMENT` is right exactly once.** When the objection is concrete, the
Developer is the cheapest agent that can act on it and the rework machinery
exists. What (a) cannot do on its own is stop; §5.4 supplies that.

### 5.3 Why homologation's evidence base decides this

This is not a general preference for leniency. It follows from what this
particular agent is given:

| Property | Value | Source |
|---|---|---|
| Tools | `["Read"]` — no Grep, no Glob, no Bash | `src/server/agents/roles.ts:112` |
| Consumes | `stories`, `qa_report` | `roles.ts:114` |
| Diff | **summary only** — `--stat`, capped at 8 000 chars | `execute.ts:180-187`, `:50` |
| Model | `models.light`, the cheapest default the pipeline uses | `src/server/settings/store.ts:65` |
| `maxTurns` | 10 — the lowest of any agent that opens the repository | `store.ts:82-92` |

Two rows are deliberately hedged. `STAKEHOLDER_REFINEMENT` also runs on
`models.light` (`store.ts:59`) and gets only 6 turns (`store.ts:83`), so
homologation is not the outright cheapest or shortest-leashed agent — it is the
cheapest and shortest-leashed of the ones that see the code. The Stakeholder has
no tools and no workspace at all (`roles.ts:42`, `:46`) and reviews nothing, so it
is not a counter-example to anything below.

`executeAgentStage` branches the supplement explicitly: `QA` and `CODE_REVIEW`
get `diffAgainstBase` (up to 60 000 chars), homologation gets
`diffStatAgainstBase` (`execute.ts:170-188`). It sees file names and line counts,
cannot search the repository, and can `Read` a file whose path it already knows —
within ten turns, most of them spent on the stories. So its rejection is a
*second opinion on the acceptance criteria*, formed from QA's report and a file
list, where QA formed the first by running the suite and reading the whole diff
(`prompts/qa.md:10-17`). Useful, because a second reader catches what the first
rationalised. Not strong enough to destroy a branch (d) or to outrank an approved
technical plan (b). Strong enough for one Developer pass: hence (a), once.

### 5.4 The escalation rule

The rule needs the number of homologation passes, which already exists:
`countStageRuns(taskId, "PO_HOMOLOGATION")` (`src/server/tasks/service.ts:466-473`),
the same call `contextFor` makes for `DEVELOPMENT` (`orchestrator.ts:71`). No
column, no migration.

```ts
// state-machine.ts — PipelineContext gains one field
/** PO_HOMOLOGATION runs so far, including the one being handled. */
homologationAttempts: number;

// orchestrator.ts — contextFor
homologationAttempts: countStageRuns(task.id, "PO_HOMOLOGATION"),

// state-machine.ts — the new branch, before the LINEAR_SUCCESSOR lookup
if (current === "PO_HOMOLOGATION") {
  if (signal.homologationVerdict === "accepted") {
    return { type: "await_gate", gate: "STAKEHOLDER_GATE" };
  }
  if (context.homologationAttempts <= 1 && reworkBudgetAvailable(context)) {
    return {
      type: "run",
      stage: "DEVELOPMENT",
      attempt: context.developmentAttempts + 1,
    };
  }
  // Second rejection, or no budget left. Escalate rather than fail: the branch
  // passed code review and QA, and only a human can decide whether "not what we
  // asked for" means ship it, rework it, or drop it.
  return { type: "await_gate", gate: "STAKEHOLDER_GATE" };
}
```

**This branch deliberately does not call `reworkOrFail`.** That helper's other
half is a `terminal FAILED` when the budget is spent (`state-machine.ts:106-122`)
— the outcome §5.2 rejects. What it shares is the budget predicate, which must not
drift, so the predicate is extracted (`reworkBudgetAvailable(context)` =
`developmentAttempts <= reworkMaxCycles`) and `reworkOrFail` is rewritten to call
it: no behaviour change, one definition of "budget left".

**One caveat on the counter.** `countStageRuns` counts *every* row for the stage,
including one that failed technically and was re-run (`service.ts:466-473`), so a
`PO_HOMOLOGATION` run that died on an invalid artifact and was retried makes the
next pass `homologationAttempts === 2` and forfeits the rework. That is the same
approximation `developmentAttempts` already lives with (`orchestrator.ts:71`),
and correcting it belongs with `spec-retry-recovery.md` §6's budget grant rather
than here — but it is an approximation, not an exact count of homologation
opinions delivered.

### 5.5 The ping-pong loop, bounded

Without the cap the loop is not hypothetical, it is the expected case.
Homologation's inputs on a second pass are `stories.md` (unchanged) and a fresh
`qa_report`; if its objection was to the stories, the Developer cannot change the
stories, so pass two objects again, and again, until `reworkMaxCycles` is spent —
at which point `reworkOrFail` fails a task that passed QA twice, each cycle having
cost a `DEVELOPMENT`, a `CODE_REVIEW`, a `QA` and a `PO_HOMOLOGATION` run. The cap
makes the worst case exactly one extra cycle.

Homologation draws on the *same* `reworkMaxCycles` as the two reviewers
(`state-machine.ts:42-46`), so with the default of 2 (`config/env.ts:151`) a task
that already reworked twice on QA findings escalates immediately, with no
homologation rework at all. Correct: the budget bounds total spend per task, and
homologation is the last stage that should be allowed to overdraw it. That
field's doc comment currently enumerates its consumers — "`CODE_REVIEW`, `QA` and
`HUMAN_CODE_REVIEW`" — and must gain `PO_HOMOLOGATION`, or the next reader will
have exactly the wrong list.

---

## 6. `STAKEHOLDER_GATE` becomes a three-decision gate

A human landing on the stakeholder gate holding a homologation rejection has two
options today: approve delivery of something an agent says is not what was asked
for, or `reject`, which is terminal (`state-machine.ts:154-156`) and throws the
branch away. That menu would make §5.4's escalation worse than useless.

```ts
// src/server/pipeline/stages.ts:181 — the entire code change
  STAKEHOLDER_GATE: ["approve", "request_changes", "reject"],
```

`request_changes` is handled *before* the gate switch in `nextTransition`
(`state-machine.ts:157-159`) and is already gate-agnostic; the table at
`stages.ts:181` is the only thing refusing it. The panel derives its buttons from
that same table (`task-actions.tsx:70-71`), the comment requirement is enforced on
both sides (`task-actions.tsx:77-80`, `orchestrator.ts:619-623`), and the comment
already becomes a `human_review` artifact the Developer receives
(`orchestrator.ts:631-636`).

**It is a re-admission, not just a transition.** `spec-task-queue.md` §8.3 lists
"gate approved, or `request_changes` that resumes the task" as *taking* a slot,
because a gated task released its own (§8.4). So a `request_changes` at
`STAKEHOLDER_GATE` resolving to `run DEVELOPMENT` goes through the same
capacity branch every other gate resume does and may park the task at
`gate_queued` rather than returning it to `DEVELOPMENT` immediately
(`orchestrator.ts:647-652`). No new code — the branch keys on
`transition.type === "run"`, not on which gate produced it — but "request changes
sends it back to the Developer" is only true when a slot is free.

**This contradicts `spec-code-review.md` §6.2, deliberately.** That table marks
`request_changes` on `STAKEHOLDER_GATE` as a 400, reasoning that the gate's
question is "do not ship". The reasoning held while nothing could arrive there
carrying a machine rejection: the only path in was a clean homologation, so "not
now" and "not ever" really were one decision. Once homologation can escalate they
separate — "this does not meet criterion 3, fix it" is neither approval nor
abandonment. `GATE_COPY.STAKEHOLDER_GATE` (`task-actions.tsx:35-41`) gains a
sentence saying so. `PLAN_GATE` keeps its two decisions: nothing has been built
yet, so "request changes" there is `reject` with extra steps.

---

## 7. Making the rejection reach the Developer

A rework the Developer cannot explain is a wasted cycle — `spec-code-review.md`
§6.3's argument for human comments, applied to a machine one. The channel exists;
homologation is simply not on it.

```ts
// src/server/pipeline/execute.ts:105-110 — today
if (stage === "DEVELOPMENT" && attempt > 1) {
  for (const type of ["code_review_report", "qa_report", "human_review"] as const) {
    const artifact = latestArtifact(taskId, type);
    if (artifact) inputs.push({ type, content: artifact.contentMd });
  }
}
```

`homolog_report` joins the list **third — after `qa_report`, before
`human_review`**. Version 0.1 of this section put it last and justified it with
the ordering comment at `execute.ts:102-104`. That reading was wrong: the comment
does not say "the final entry is the operative one", it says *"Human feedback
comes last so it reads as the final word"*, and `spec-code-review.md` §6.3 marks
the same slot `// ← human feedback, highest authority`. Appending after
`human_review` would demote a human's requested changes below a machine report on
every rework where both exist — the one ordering the codebase has deliberately
fixed. Machine reports keep their pipeline order among themselves
(`code_review_report`, `qa_report`, `homolog_report`), and the human stays last.

No synthesized artifact is needed, unlike the human `request_changes` path
(`orchestrator.ts:631-636`): `homolog_report` is a validated artifact already
persisted by `executeAgentStage` (`execute.ts:247-252`). It also stays inside the
minimum-context rule — the Developer receives the *document*, never the
homologation transcript (`artifacts.ts:10-17`, `execute.ts:102-104`).

`prompts/developer.md:21-25`, currently headed *"If you received a QA report"*,
becomes *"If you received a reviewer's report"* and names all four, with one line
on what a homologation report means: an acceptance criterion is disputed, and if
it cannot be met as written, saying so precisely in `## Follow-ups` is the correct
response rather than inventing scope.

---

## 8. Latent bugs this change trips

### 8.1 `LINEAR_SUCCESSOR`'s gate branch becomes unreachable

Removing `PO_HOMOLOGATION: "STAKEHOLDER_GATE"` (`state-machine.ts:74`) is
mandatory — leaving it beside the explicit branch gives one transition two
contradictory sources of truth, and the table is the one a reader finds first.
After the removal the table holds only `STAKEHOLDER_REFINEMENT → PO_REFINEMENT`,
`PO_REFINEMENT → ARCHITECTURE`, `DEVELOPMENT → CODE_REVIEW`,
`DELIVERY → COMPLETED`. **No value in it is a gate**, so `if (isGate(successor))`
at `state-machine.ts:212-214` becomes dead code with no producer.

**Keep it.** The type is `Partial<Record<Stage, Stage>>`, which permits a gate
value, and the failure mode without the guard is nasty: the transition would be
`{ type: "run", stage: "STAKEHOLDER_GATE" }`, `applyTransition`'s `run` case
(`orchestrator.ts:103-106`) would call `setTaskStage` (so `statusForStage`
reports `awaiting_gate`, `stages.ts:107`) *and* `scheduleStage`
(`orchestrator.ts:87-98`), which enqueues a `run_stage` job for every stage that
is not `DELIVERY` (`:93-97`) — a job `executeAgentStage` then rejects with
`"STAKEHOLDER_GATE is not an agent stage."` (`execute.ts:119-121`) — a task
showing as awaiting approval while its job fails in a loop. The branch gets a
comment saying it is defensive and currently unreachable, so the next reader does
not delete it as dead.

### 8.2 The Developer can be handed a stale homologation report

`latestArtifact` returns the newest row of a type for the task, ordered by
`createdAt` (`service.ts:495-505`), with no relation to the current cycle. Adding
`homolog_report` to `gatherInputs` therefore means that once a task has been
through homologation at all, **every subsequent Developer rework receives that
report** — including reworks triggered by a later `CODE_REVIEW` or `QA` rejection
about something else. The hazard already exists for `code_review_report` and
`qa_report`; a fourth report widens it, and homologation is the worst one to be
stale about, since after a homologation-driven rework the next copy describes
criteria the Developer has already addressed.

**Fix it here rather than inheriting it.** `gatherInputs` filters each report by
recency — but the cutoff must be the **previous** Development run, not the last
one. Version 0.1 of this section said `artifact.createdAt >=
(lastDevRun.startedAt ?? lastDevRun.createdAt)` with `lastDevRun` = the last
`DEVELOPMENT` entry of `listStageRuns(taskId)`. That predicate filters out
everything it is meant to keep: `scheduleStage` creates the stage-run row before
enqueueing the job (`orchestrator.ts:87-98`), and `executeAgentStage` marks it
`running` at `execute.ts:132` — both *before* `gatherInputs` runs at `:190`. So
the last `DEVELOPMENT` entry is the run currently executing, every report from
the cycle that triggered it predates its `startedAt`, and the Developer would
receive nothing at all.

The cutoff is the run whose code the reports were written against:

```ts
const devRuns = listStageRuns(taskId).filter((run) => run.stage === "DEVELOPMENT");
// -1 is the run executing right now; -2 is the one the reviewers reviewed.
const previousDevRun = devRuns.at(-2);
const since = previousDevRun
  ? (previousDevRun.startedAt ?? previousDevRun.createdAt)
  : 0; // No earlier Development run: nothing can be stale, keep everything.
```

`listStageRuns` orders by `createdAt` ascending (`service.ts:418-425`), so `.at(-2)`
is well defined. `human_review` is exempt from the filter regardless: a human's
comment stays authoritative until acted on, and is written against the run the
reviewer was looking at (`orchestrator.ts:624-630`).

### 8.3 The `human_review` artifact hangs off the homologation run

`decideGate` attaches a `request_changes` comment to
`listStageRuns(input.taskId).at(-1)` (`orchestrator.ts:627`), because
`artifacts.stage_run_id` is `NOT NULL` (`src/server/db/schema.ts:116-118`). With
§6 enabling `request_changes` on `STAKEHOLDER_GATE`, that last run is the
`PO_HOMOLOGATION` run, so a stakeholder's requested changes are recorded as an
artifact of the homologation stage run. Harmless for retrieval (`latestArtifact`
keys on task and type, not run), but worth naming: an audit grouping artifacts by
producing stage will attribute this one to homologation. `spec-audit-trail.md` is
where it gets solved, with a nullable column or an explicit author discriminator.

### 8.4 Two existing tests pass only because the verdict is ignored

`tests/state-machine.test.ts:272-280` asserts that `PO_HOMOLOGATION` with a bare
`stage_succeeded` — no verdict at all — parks on `STAKEHOLDER_GATE`; under §4.3
that signal is a rejection. Its current form is a codified assertion that the
verdict does not matter. `tests/pipeline-flow.test.ts:163` does the same through
`completeCurrentStage(task.id)`, whose helper at `:67-79` gains a third parameter.
Both are the regression surface, not collateral damage — §11.

---

## 9. What does not change, and how it is surfaced

The absence is load-bearing. **No schema change and no migration**:
`homologationAttempts` is derived from `stage_runs` by the existing
`countStageRuns`, and the verdict is a pure function of the persisted
`homolog_report`, so nothing joins the `MIGRATIONS` array
(`src/server/db/migrations.ts:39-64`). **No new stage, gate, artifact type or
role**: `STAGES`, `GATES`, `ARTIFACT_TYPES` and `ROLES` are untouched, so no board
column, no `STAGE_LABELS` entry, no `stage-badge` tone. **No new event type**:
`PipelineEvent` (`src/server/events/store.ts:15-33`) is unchanged. The feature is
one extraction call, one signal field, one context field, one state-machine
branch, one table entry moved, one gate decision enabled, one prompt-input list
extended.

`executeAgentStage` announces the verdict exactly as `execute.ts:290-297` does for
reviewers: an `appendEvent` of type `log`, level `info` on acceptance and `warn`
otherwise, message `` `${role.name} verdict: ${homologationVerdict}.` ``.

The routing consequence is logged by **`advanceTask`** (`orchestrator.ts:137-151`),
and it has to be. `nextTransition` is pure and side-effect free by contract
(`state-machine.ts:10-16`), so it cannot log; and the returned transition alone is
not enough to tell the two outcomes apart — acceptance and second-rejection
escalation both return the byte-identical
`{ type: "await_gate", gate: "STAKEHOLDER_GATE" }`. `advanceTask` is the only
place holding *both* the signal and the transition, so it is the only place that
can distinguish them: `signal.kind === "stage_succeeded" && signal.stage ===
"PO_HOMOLOGATION" && signal.homologationVerdict !== "accepted" &&
transition.type === "await_gate"`.

```json
{ "type": "log", "level": "warn",
  "message": "Homologation rejected the change for the second time. Escalating to the stakeholder gate — a repeated rejection after a rework is usually a problem with the acceptance criteria, which no agent here can rewrite." }
```

**At the gate.** The task detail page already loads every latest artifact
(`src/app/(dashboard)/tasks/[id]/page.tsx:36`) and renders `GatePanel` when the
task is `awaiting_gate` (`:129-131`). It calls `extractHomologationVerdict` on the
`homolog_report` it already holds and passes the result to `GatePanel`. On
`"rejected"` the panel leads with a warning band — *"Homologation rejected this
change. Read `homolog-report.md` before approving delivery."* — and *Request
changes* is promoted to the visually primary button. That promotion is **new**,
not a match of an existing pattern: today `GatePanel` hard-codes *Approve* as
`variant="success"`, *Request changes* as the plain default variant and *Reject*
as `variant="danger"` for every gate including `HUMAN_CODE_REVIEW`
(`task-actions.tsx:138-151`), so the emphasis has to become conditional on the
verdict rather than borrowed. Deriving the band from the artifact
rather than a stored flag keeps it correct after a re-run, with nothing to sync.

---

## 10. Documentation corrections

**`README.md:271-274`.** Replace:

> Every artifact must contain a fixed set of `##` sections, validated by the
> worker before the pipeline advances. A malformed artifact fails the stage
> rather than being passed on. The QA and homologation verdicts fail closed:
> anything that cannot be parsed as a pass is treated as a rejection.

with:

> Every artifact must contain a fixed set of `##` sections, validated by the
> worker before the pipeline advances. A malformed artifact fails the stage
> rather than being passed on. The code review, QA and homologation verdicts all
> fail closed: anything that cannot be parsed as a pass is treated as a
> rejection. A code review or QA rejection returns the work to the Developer. A
> homologation rejection does too — once — and then parks the task at the
> stakeholder gate with the rejection in view: a repeated homologation failure is
> usually a problem with the acceptance criteria rather than the code, and no
> agent in the pipeline can rewrite those.

The diagram at `README.md:228-248` gains the branch under `PO_HOMOLOGATION`, and
line 246 — *"Rework from any reviewer shares one budget (REWORK_MAX_CYCLES)"* —
becomes literally true of homologation too.

**`prompts/homologation.md:32-34`.** Replace the "does not stop the pipeline"
paragraph quoted in §3.2 with:

> Accept only when every `must` criterion is met. A `rejected` verdict stops the
> pipeline: the work returns to the Developer with this report as their only
> instruction, and if you reject a second time the task parks in front of the
> human stakeholder with your report in view. Name the criterion that failed and
> what would satisfy it. Do not reject over something the stories did not ask
> for — record that under `## Notes` instead.

**`prompts/developer.md:21-25`** — retitled and extended per §7.

---

## 11. Test plan

**State machine (pure, no DB)**

- **Regression, fails today.** A rejected verdict must not reach the gate:

  ```ts
  it("does not advance a rejected homologation to the stakeholder gate", () => {
    expect(
      nextTransition(
        "PO_HOMOLOGATION",
        { kind: "stage_succeeded", stage: "PO_HOMOLOGATION", homologationVerdict: "rejected" },
        { ...base, developmentAttempts: 1, homologationAttempts: 1 },
      ),
    ).toEqual({ type: "run", stage: "DEVELOPMENT", attempt: 2 });
  });
  ```

  Against `main` this returns `{ type: "await_gate", gate: "STAKEHOLDER_GATE" }`,
  because `nextTransition` has no `PO_HOMOLOGATION` branch and falls through to
  `LINEAR_SUCCESSOR` (`state-machine.ts:206-215`).

- `"accepted"` → `await_gate STAKEHOLDER_GATE`. **No verdict** → the rejection
  path, not the gate — the §4.3 wiring-bug guard, which fails today for the same
  reason as the test above. `homologationAttempts: 2` + rejected → the gate,
  never `DEVELOPMENT`, whatever the remaining budget.
- Rejected with `developmentAttempts > reworkMaxCycles` → `await_gate
  STAKEHOLDER_GATE`, **not** `terminal FAILED`. Sits beside the shared-budget
  suite (`tests/state-machine.test.ts:141-189`), which asserts the opposite for
  the three reviewers — the contrast is §5.2's point and should read that way.
- A `homologationVerdict` on a `CODE_REVIEW` or `QA` signal is ignored; a
  `reviewVerdict` on a `PO_HOMOLOGATION` signal does not count as acceptance.
- `STAKEHOLDER_GATE` + `request_changes` → `DEVELOPMENT`; with the budget spent →
  `terminal FAILED` naming the budget (the human path keeps `reworkOrFail`).
  `PLAN_GATE` + `request_changes` still throws `InvalidGateDecisionError`
  (`tests/state-machine.test.ts:248-258` narrows from two gates to one).

**Artifacts** — `extractHomologationVerdict` keeps its coverage
(`tests/artifacts.test.ts:157-165`) and gains the `not accepted` case, matching
the review parser's `not approved` case (`:116-118`). A `homolog_report` missing
`## Verdict` still fails `validateArtifact`, so the stage fails before any verdict
is read.

**Integration (`tests/pipeline-flow.test.ts`)**

- A rejected first homologation produces runs
  `[… PO_HOMOLOGATION 1, DEVELOPMENT 2, CODE_REVIEW 2, QA 2, PO_HOMOLOGATION 2]`
  with no unique-index collision — `scheduleStage` derives the attempt from
  `countStageRuns` (`orchestrator.ts:87-98`), exactly the case its doc comment at
  `:79-86` anticipates.
- Two consecutive rejections leave the task `awaiting_gate` on
  `STAKEHOLDER_GATE`, `failureReason` null; with the budget already spent, the
  first rejection escalates instead of failing.
- The Developer's inputs on a homologation-driven rework include
  `homolog_report`, in position three, ahead of `human_review` (§7) — assert the
  order, not just the membership, since the ordering is the part a refactor
  breaks silently. The recency filter gets its own case: a `qa_report` written
  before the *previous* `DEVELOPMENT` run is excluded while the `homolog_report`
  that triggered this rework is kept (§8.2). The naive "last `DEVELOPMENT` run"
  cutoff passes an exclusion-only test and fails this one, which is the reason to
  write it.
- `request_changes` at `STAKEHOLDER_GATE` writes a `human_review` artifact and
  returns the task to `DEVELOPMENT`; without a comment it throws `GateError` and
  the task stays on the gate — mirroring `pipeline-flow.test.ts:231-254`. Note
  the file sets `maxParallelTasks: 99` in `beforeAll` (`:33-37`), which is what
  makes "returns to `DEVELOPMENT`" unconditional here; the capacity-blocked
  variant that parks at `gate_queued` (§6) belongs in `admission.test.ts`.

**Component** — `GatePanel` on `STAKEHOLDER_GATE` renders three buttons, and the
rejection band only when the verdict is `"rejected"`.

---

## 12. Phasing

**Phase A — make the verdict real.** Extraction in `executeAgentStage`, the signal
field, `homologationAttempts`, the state-machine branch, the `LINEAR_SUCCESSOR`
removal with its dead-branch comment (§8.1), the `homolog_report` input (§7) and
the prompt corrections. No UI work: an escalated task parks on a gate the board
already renders. Independently valuable — after Phase A the stage has an outcome,
which is the whole defect.

**Phase B — the human's third option.** `request_changes` on `STAKEHOLDER_GATE`
(§6). Independently valuable and revertible: one entry in
`GATE_ALLOWED_DECISIONS` plus copy, improving the gate even for tasks whose
homologation accepted. Second because Phase A is coherent without it.

**Phase C — the gate band and the report-recency filter** (§9, §8.2). Both refine
behaviour that is already correct: without C the reviewer opens the artifact tab
to find the verdict, and the Developer occasionally reads a stale report.

---

## 13. Open questions

1. **One homologation rework, or one per Development attempt?** The cap is per
   task (`homologationAttempts <= 1`), so a task whose second homologation objects
   to something genuinely new — introduced by the rework itself — escalates rather
   than fixing it. The alternative, a rework whenever the budget permits, trusts
   the pipeline's weakest agent with its most expensive loop. The cap is the safe
   default; whether it is the right one is measurable from how often escalated
   tasks are then approved unchanged at the gate.
2. **Should the verdict be structured rather than parsed?** `homolog_report`
   already requires `## Acceptance Criteria Checklist` (`artifacts.ts:72-76`). As a
   parseable table, the rework could name the failing criteria in the Developer's
   prompt instead of handing over the whole document, and the band could say
   *"2 of 7 criteria not met"*. Needs a schema, a parser with its own fail-closed
   rule, and UI. Excluded because the routing decision does not depend on it.
3. **Is `PO_HOMOLOGATION` worth its cost once the verdict binds?** It is the
   cheapest stage (`spec-cost-forecast.md` §3: ~2% of a task) and the only check
   asking "did we build the right thing", but also a second pass over criteria QA
   already walked (`prompts/qa.md:12-17`) with strictly less evidence. If its
   rejections correlate almost perfectly with QA's, the honest conclusion is to
   merge the two rather than keep a stage whose independent contribution is noise.
   A measurement, available after a few dozen tasks.
4. **Does the escalation need to survive `retryTask`?** A task escalated and then
   rejected by the stakeholder reaches `REJECTED`, terminal and not retryable —
   only `failed` is (`orchestrator.ts:737-739`). Deliberate here, but
   `spec-retry-recovery.md` may reopen it: unlike a technical failure, a
   homologation escalation ends with a branch that builds and passes its tests,
   and "reject now, revisit after clarifying the stories" is a plausible workflow
   the current terminal set cannot express.
