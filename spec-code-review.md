# Code Review Stages — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Two new pipeline stages — an **agent code review** after
> Development, and an **optional human code review** before delivery, backed by
> a diff viewer.
> **Prerequisite:** the pipeline described in `spec-esteira-multiagente.md`, as built.
> **Related:** `spec-task-queue.md` (a gate holds a concurrency slot — see §11.3).

---

## 1. Summary

Two additions, deliberately different in kind:

**`CODE_REVIEW`** — a new agent stage that runs immediately after
`DEVELOPMENT` and reviews the diff for defects, security problems and
maintainability. It has a verdict and can send work back to the Developer, the
same way QA can. It always runs.

**`HUMAN_CODE_REVIEW`** — a new human gate, enabled per task at creation time.
When enabled, no delivery happens until a person has read the diff and approved
it. It is backed by a **diff viewer**: a screen listing every added, modified,
renamed and deleted file, with the unified diff per file.

The revised pipeline:

```
… → PLAN_GATE
     └─► DEVELOPMENT        agent · commits + dev-report.md
          └─► CODE_REVIEW   agent · code-review-report.md          ← NEW
               ├─ changes_requested → DEVELOPMENT
               └─► QA       agent · qa-report.md
                    ├─ changes_requested → DEVELOPMENT
                    └─► HUMAN_CODE_REVIEW   human · diff viewer    ← NEW (optional)
                         ├─ request_changes → DEVELOPMENT          ← new decision kind
                         ├─ reject → REJECTED
                         └─► PO_HOMOLOGATION
                              └─► STAKEHOLDER_GATE → DELIVERY → COMPLETED
```

---

## 2. Scope

**In scope**

- A `CODE_REVIEW` agent stage with its own role, prompt and artifact.
- Narrowing the QA role so the two do not duplicate each other (§5).
- An optional `HUMAN_CODE_REVIEW` gate, configured per task.
- A third gate decision, `request_changes`, that returns work to the Developer.
- A diff viewer screen and the API behind it.
- Feeding human review comments back to the Developer as a real input artifact.

**Out of scope**

- Line-level or range-level comments on the diff. The human's feedback is one
  Markdown comment per decision. (See §14.)
- Reviewing anything other than the task branch against its base.
- Syntax highlighting beyond added/removed line colouring (§10.5).
- Making the agent code review optional — it always runs. (See §14.)

---

## 3. Why `CODE_REVIEW` sits before QA

`DEVELOPMENT → CODE_REVIEW → QA` rather than the reverse, for two reasons:

1. **Cheap failures first.** A code review reads the diff; QA clones the
   behaviour — it runs the test suite, the linter and the build, which is the
   expensive part of the pipeline. Catching an obvious defect before paying for
   a full QA run is worth the ordering.
2. **Shorter rework loops.** A rejection from `CODE_REVIEW` costs one agent run
   to detect. A rejection from QA costs a code review plus a QA run.

The alternative — `DEVELOPMENT → QA → CODE_REVIEW` — has one argument in its
favour: there is no point reviewing code that does not build. That is real, and
it is mitigated by the Developer's own prompt, which already requires running
the project's checks before reporting. If reviews of non-building code turn out
to be common in practice, reversing the order is a small change confined to
`LINEAR_SUCCESSOR`.

---

## 4. The `CODE_REVIEW` role

```ts
CODE_REVIEW: {
  stage: "CODE_REVIEW",
  name: "Code Reviewer",
  promptFile: "code-reviewer.md",
  allowedTools: ["Read", "Grep", "Glob", "Bash"],   // Bash under the read-only allowlist
  permissionMode: "default",
  consumes: ["stories", "techplan", "dev_report"],
  produces: "code_review_report",
  needsWorkspace: true,
  canWrite: false,
}
```

**Consumes** the stories (to know the intended scope), the technical plan (to
check the implementation matches what was approved) and the developer's report
(to know what was claimed), plus the branch diff as a supplement — the same
mechanism `QA` already uses in `executeAgentStage`.

**Tools.** Read-only, with Bash restricted by the existing allowlist in
`guardrails.ts`. The reviewer needs `git diff`, `git log` and `git show`, all
already permitted. It does **not** need to run tests — that is QA's job, and
letting both run the suite doubles the slowest part of the pipeline.

**Model.** `MODEL_DEFAULT` initially. Code review is one of the tasks where a
stronger model most clearly pays for itself, so `MODEL_HEAVY` is worth an A/B
once the stage exists. It is per-role configurable in Settings already.

**`maxTurns`:** 40, matching QA.

### 4.1 The `code_review_report` artifact

New artifact type `code_review_report` → `code-review-report.md`.

```ts
code_review_report: {
  type: "code_review_report",
  description: "Code review verdict against the diff",
  requiredSections: ["Verdict", "Summary", "Findings", "Files Reviewed"],
}
```

`## Verdict` carries exactly one line, parsed by the same fail-closed rule as
QA — anything that cannot be read as `approved` counts as a rejection:

```
Verdict: approved
Verdict: changes_requested
```

`extractQaVerdict` in `artifacts.ts` is already generic over the document; it
should be renamed `extractReviewVerdict` and reused for both stages rather than
duplicated.

Each entry under `## Findings` must carry a **severity** (`blocker`, `major`,
`minor`, `info`) and a location (file plus line or symbol). Only `blocker` and
`major` justify `changes_requested`; the prompt must say so explicitly, because
a reviewer that blocks on `minor` findings will loop the pipeline until the
rework budget runs out.

### 4.2 The prompt — `prompts/code-reviewer.md`

Key instructions, in the same voice as the existing role prompts:

- Review the diff, not the report. `git diff origin/<base>...HEAD` is the
  evidence; `dev-report.md` is a claim.
- Check the implementation against `techplan.md` — an approach that silently
  diverged from the approved plan is a finding.
- Look for: defects, unhandled error paths, security-relevant changes, secrets
  committed by accident, debug code left behind, and code that does not match
  the conventions of the surrounding file.
- **Report every finding with its severity, including ones you would not block
  on.** Coverage is the goal at this stage; the verdict is a separate judgement.
  A prompt that says "only report important issues" measurably lowers recall —
  the model investigates just as hard and then withholds.
- Do not review scope. If the change does something the stories did not ask for,
  that is a finding; whether the stories were right is not this role's question.
- Do not run the test suite.

---

## 5. QA must be narrowed

`prompts/qa.md` currently instructs QA to "review the diff", "look for what the
criteria do not cover", and to find "broken existing behaviour, unhandled error
paths, security-relevant changes, secrets, debug code" — which is, verbatim, the
new reviewer's job.

**Leaving both prompts as they are means paying twice for the same work and
getting two verdicts that can disagree.** With `CODE_REVIEW` in place, QA's
prompt narrows to:

- Run the project's checks and report the real outcome.
- Walk the acceptance criteria one at a time, with evidence for each.
- Verify the change does what the stories said, not whether the code is good.

QA keeps its verdict and its rework loop — a change can pass review and still
fail acceptance.

This edit is **part of the feature, not a follow-up.** Shipping `CODE_REVIEW`
without it produces a pipeline that is measurably slower and no more thorough.

---

## 6. The `HUMAN_CODE_REVIEW` gate

### 6.1 Placement

After `QA`, before `PO_HOMOLOGATION`.

The determining argument is what a rejection means. A code review rejection
sends work back to the Developer. If the gate sat after `STAKEHOLDER_GATE`, a
rejection would invalidate an approval a human had already given — incoherent.
Placing it with the other technical stages also means the Product Owner and the
stakeholder only ever see code a human has already vetted.

The alternative — after `PO_HOMOLOGATION` — spends slightly less human time in
the case where homologation fails, at the cost of that incoherence. Not worth it.

### 6.2 Three decisions, not two

`GATE_DECISIONS` is currently `["approve", "reject"]`, and every rejection is
terminal. That is right for `PLAN_GATE` (the approach is wrong) and for
`STAKEHOLDER_GATE` (do not ship). It is wrong for a code review, where the
normal negative outcome is "fix these things", not "abandon the task".

`GATE_DECISIONS` becomes `["approve", "request_changes", "reject"]`, with
per-gate validity:

| Gate | `approve` | `request_changes` | `reject` |
|---|---|---|---|
| `PLAN_GATE` | → `DEVELOPMENT` | — (400) | → `REJECTED` |
| `HUMAN_CODE_REVIEW` | → `PO_HOMOLOGATION` | → `DEVELOPMENT` | → `REJECTED` |
| `STAKEHOLDER_GATE` | → `DELIVERY` | — (400) | → `REJECTED` |

A `request_changes` sent to a gate that does not accept it is a 400, not a
silent coercion.

**`request_changes` requires a non-empty comment.** An empty one gives the
Developer nothing to act on and wastes a full rework cycle. Enforce it in the
Zod schema, conditionally on the decision.

### 6.3 The comment must reach the Developer

Today `approvals.comment` is stored and displayed but never enters a prompt. A
`request_changes` whose reasoning the Developer never sees is worse than
useless — the Developer will re-submit the same code.

On `request_changes`, the worker persists the comment as an artifact of type
`human_review` (`human-review.md`), so it flows through the existing input
machinery with no special case:

```ts
// executeAgentStage → gatherInputs, extending the existing rework branch
if (stage === "DEVELOPMENT" && attempt > 1) {
  appendIfPresent("code_review_report");
  appendIfPresent("qa_report");
  appendIfPresent("human_review");     // ← human feedback, highest authority
}
```

The Developer's prompt gains a short section: human review feedback outranks the
agent reports where they conflict.

The synthesized artifact is validated like any other, with a single required
section (`## Requested Changes`), so a malformed one cannot silently reach the
Developer as an empty document.

---

## 7. Rework loops and the shared budget

Three sources can now send work back to `DEVELOPMENT`: `CODE_REVIEW`, `QA`, and
`HUMAN_CODE_REVIEW`.

**They share one budget.** `PipelineContext.developmentAttempts` counts
`DEVELOPMENT` runs and `qaMaxCycles` caps them; that model still holds and needs
no structural change. But the name no longer describes it:

- `qaMaxCycles` → **`reworkMaxCycles`** in `AppSettings` and `PipelineContext`.
- `QA_MAX_CYCLES` → **`REWORK_MAX_CYCLES`**, with the old variable still read as
  a fallback so existing `.env` files keep working.

**A rejection re-runs the full review chain.** `DEVELOPMENT → CODE_REVIEW → QA`
runs again after any rejection, including one from QA — new code needs a new
review. That is correct and it is expensive; see §12.

**The human gate does not consume budget by itself**, but the `DEVELOPMENT` run
it triggers does, and can exhaust it. When the budget is spent, the task fails
with the existing message. A human who has just asked for changes and gets
`FAILED` instead of a new attempt will find that surprising, so the failure
reason must name the cause explicitly: *"Rework budget of N cycles exhausted;
raise `reworkMaxCycles` in Settings to continue."*

---

## 8. State machine changes

### 8.1 A latent bug this feature would trip

```ts
// src/server/pipeline/state-machine.ts:101 — today
return signal.gate === "PLAN_GATE"
  ? { type: "run", stage: "DEVELOPMENT", attempt: context.developmentAttempts + 1 }
  : { type: "run", stage: "DELIVERY", attempt: 1 };
```

The `else` branch means *"any gate that is not `PLAN_GATE` goes to delivery"*.
Adding `HUMAN_CODE_REVIEW` would make an approval there **skip homologation and
the stakeholder gate and go straight to delivery**, with no type error to catch
it.

This must become an exhaustive `switch` over `Gate` with a `never` check on the
default branch, so the next gate added fails to compile instead of shipping.

### 8.2 The rest

- `STAGES` gains `CODE_REVIEW` and `HUMAN_CODE_REVIEW`, positioned between
  `DEVELOPMENT`/`QA` and `QA`/`PO_HOMOLOGATION` respectively.
- `AGENT_STAGES` += `CODE_REVIEW`; `GATES` += `HUMAN_CODE_REVIEW`;
  `BOARD_STAGES` += both. `STAGE_LABELS` is a total `Record<Stage, string>`, so
  TypeScript forces the labels.
- `LINEAR_SUCCESSOR`: `DEVELOPMENT → CODE_REVIEW`. `QA` and `CODE_REVIEW` both
  branch on a verdict and stay outside the table.
- The signal's `qaVerdict` field is renamed **`reviewVerdict`** — `CODE_REVIEW`
  and `QA` produce the same shape, and two near-identical fields would invite
  passing the wrong one.
- `PipelineContext` gains `humanCodeReviewRequired: boolean`, read from the task
  row, deciding whether `QA` approval routes to `HUMAN_CODE_REVIEW` or straight
  to `PO_HOMOLOGATION` — the same shape as the existing `planGateRequired`.

---

## 9. Data model

```sql
ALTER TABLE tasks ADD COLUMN require_human_code_review INTEGER NOT NULL DEFAULT 0;
```

Boolean as `0`/`1`, matching Drizzle's SQLite integer-boolean convention.

New artifact types `code_review_report` and `human_review` are values in an
existing text column — no schema change, but `ARTIFACT_TYPES`,
`ARTIFACT_FILENAMES` and `ARTIFACT_SPECS` must all gain entries (all three are
total records, so the compiler enforces it).

> As with `spec-multi-provider-repositories.md`, this `ALTER TABLE` is not
> applied by the `CREATE TABLE IF NOT EXISTS` bootstrap. Whichever of these two
> features lands first has to introduce the migration runner.

---

## 10. The diff viewer

### 10.1 Where the diff comes from

The task workspace is a real clone on disk, and `workspace.ts` already has
`diffAgainstBase` and `diffStatAgainstBase`. During `HUMAN_CODE_REVIEW` the
workspace is guaranteed to exist — the task is mid-pipeline, well before the
cleanup job.

The diff is therefore **read live from the workspace, not persisted**. Diffs run
to megabytes; storing every one in SQLite to serve a screen that is usually
opened once is the wrong trade.

**After workspace cleanup** (`WORKSPACE_RETENTION_DAYS`), the full diff is gone.
To keep the historical view useful, persist only the cheap part when the task
reaches `DELIVERY`: the `--name-status` list plus per-file added/removed counts,
as a `diff_summary` artifact. The viewer then shows the file list with a note
that the full diff is no longer available locally, and links to the pull request.

### 10.2 API

```
GET /api/tasks/:id/diff              → { baseBranch, headBranch, files: DiffFile[], truncated }
GET /api/tasks/:id/diff?file=<path>  → { path, patch, binary, truncated }
```

```ts
type DiffFile = {
  path: string;
  oldPath?: string;              // set when status === "renamed"
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
};
```

The index comes from `git diff --name-status --find-renames --numstat`; the
per-file patch from `git diff -- <path>`. Fetching patches per file rather than
one blob keeps the first render fast on a large change.

**Reading the workspace from the web process is acceptable here.** It is a
local, read-only git command on the same filesystem both processes already
share (the same volume in `docker-compose.yml`). It does not touch the worker's
state and cannot interfere with a running stage.

### 10.3 Path validation — required

`?file=` is attacker-controlled input that reaches a git invocation and a
filesystem path.

**The rule: the requested path must appear in the `--name-status` output for
this task.** Reject anything else with a 400. This is airtight — the set of
valid values is computed, not parsed — and it is simpler than trying to
normalise traversal sequences.

Do not rely on `simple-git` passing arguments as an array. That prevents shell
injection, but a path beginning with `-` can still be read by git as an option;
the allowlist check removes that too.

### 10.4 Limits

| Concern | Rule |
|---|---|
| Whole diff too large | Index always returned in full; a file count over ~500 sets `truncated` and the UI warns |
| Single file too large | Patch truncated at ~200 KB with an explicit marker |
| Binary files | `binary: true`, no patch, UI shows "Binary file" plus the size change |
| Deleted files | Patch is the removal; UI shows it collapsed by default |

### 10.5 UI

**Route:** `/tasks/[id]/review` — the diff viewer plus the code review report
plus the decision controls, so the reviewer has everything on one screen. Also
reachable as a **Diff** tab on the task detail page, read-only, for any task
past `DEVELOPMENT`.

Layout: a file list on the left (path, status badge, `+n −m`), the selected
file's patch on the right.

- Patches render as a unified diff: added lines on a green-tinted row, removed
  on red-tinted, context plain, hunk headers (`@@ …`) muted. Line numbers for
  both sides in a fixed gutter.
- **Colour is not the only signal.** `+`/`−` stay visible in the gutter so the
  diff is readable without colour perception, and each row carries an
  `aria-label` naming the change type.
- Files load lazily on selection; the first file is selected automatically.
- Long paths truncate in the middle (`src/…/thing.ts`) rather than at the end,
  where the filename is.

**Rendering safety.** Diff content is untrusted repository text. React escapes
it by default — the requirement is that it stays that way. **No
`dangerouslySetInnerHTML` in the diff renderer.** If syntax highlighting is
added later it must produce React elements, not an HTML string; a highlighter
that returns markup turns a malicious repository into stored XSS against the
dashboard.

Syntax highlighting is explicitly **not** in this scope. Added/removed colouring
carries most of the value for a fraction of the weight.

### 10.6 The gate panel

`GATE_COPY` in `task-actions.tsx` is a `Record<Gate, …>`, so the compiler
requires an entry. The `HUMAN_CODE_REVIEW` panel differs from the other two:

- Three buttons — **Approve**, **Request changes**, **Reject** — with
  *Request changes* visually primary, since it is the common negative outcome.
- The comment field is required for *Request changes* and *Reject*, optional for
  *Approve*, with the requirement enforced before the request is sent.
- A prominent link to `/tasks/[id]/review`, and a summary line
  (*"14 files changed, +320 −87"*) so the size of the review is visible before
  opening it.

---

## 11. Task configuration

### 11.1 At creation

`createTaskSchema` gains `requireHumanCodeReview: z.boolean()`, defaulting to
the value from Settings.

The **New task** form gets a checkbox — *"Require human code review before
delivery"* — with a one-line explanation. It sits with priority, not with the
description, because it is a process choice rather than part of the request.

### 11.2 Default

A new setting, `humanCodeReviewDefault: boolean`, default **`false`**.

The pipeline already has two mandatory human gates. Making a third the default
would triple the interaction cost for every task, including the trivial ones the
pipeline is most useful for. Users who want it always on set it once in
Settings.

### 11.3 Editable while `CREATED`

Per `spec-task-queue.md` §6, a not-yet-started task is editable. This flag joins
the editable set. It is **not** editable after start — flipping it mid-flight
would mean either retroactively skipping a gate the task already passed or
inserting one it already went by.

> **Concurrency interaction.** `HUMAN_CODE_REVIEW` is a gate, so a task waiting
> there has status `awaiting_gate` and holds a concurrency slot under
> `spec-task-queue.md` §8.4. With `MAX_PARALLEL_TASKS = 1`, a task waiting on
> code review blocks starting new work — the same accepted trade as the existing
> gates, but it will be hit more often because this gate asks for more of the
> reviewer's time.

---

## 12. Cost impact

`CODE_REVIEW` runs once per `DEVELOPMENT` attempt. With the default two rework
cycles, a task that uses its full budget runs three code reviews on a growing
diff, plus three QA runs.

Rough shape, using the default per-role models:

| Stage | Runs (worst case, 2 reworks) | Relative cost |
|---|---|---|
| Development | 3 | highest |
| **Code review** | **3** | **moderate — reads the diff, runs no tests** |
| QA | 3 | high — runs the suite |

Two mitigations worth having from the start:

- **`maxTurns: 40`** on the reviewer. Reading a diff should not need more; a
  reviewer that hits the ceiling is exploring the whole repository and should be
  reined in by the prompt.
- **Narrowing QA (§5)** claws back much of what the new stage costs, since QA
  stops doing the review a second time.

The `/usage` page groups by stage already, so the real number will be visible
per stage after the first few tasks. No new instrumentation needed.

---

## 13. Test plan

**State machine (pure, no DB)**
- `DEVELOPMENT` success → `CODE_REVIEW`.
- `CODE_REVIEW` approved → `QA`; `changes_requested` → `DEVELOPMENT` with the
  next attempt number.
- `QA` approved with `humanCodeReviewRequired: true` → `HUMAN_CODE_REVIEW`;
  with `false` → `PO_HOMOLOGATION`.
- `HUMAN_CODE_REVIEW`: `approve` → `PO_HOMOLOGATION`, `request_changes` →
  `DEVELOPMENT`, `reject` → `REJECTED`.
- **Regression for §8.1:** `STAKEHOLDER_GATE` approve still → `DELIVERY`, and
  `PLAN_GATE` approve still → `DEVELOPMENT`, after the switch rewrite.
- `request_changes` on `PLAN_GATE` or `STAKEHOLDER_GATE` throws.
- The shared rework budget is consumed by rejections from all three sources —
  parameterised over which one rejects.

**Artifacts**
- `code_review_report` validates its four sections; a missing one fails.
- Verdict parsing is fail-closed: `approved` passes, everything else — including
  `not approved` and unparseable text — is `changes_requested`.
- `human_review` requires `## Requested Changes`.

**Diff API**
- Index reports the right status for added, modified, deleted and renamed files.
- `?file=` with a path not in the index → 400. Parameterised over `../`
  traversal, an absolute path, a path from a different task's workspace, and a
  path beginning with `-`.
- Binary file → `binary: true`, no patch.
- Missing workspace (post-cleanup) → falls back to the `diff_summary` artifact
  and reports that patches are unavailable.

**Integration**
- Full pipeline with `requireHumanCodeReview: false` never enters the gate.
- With `true`, the task parks at `HUMAN_CODE_REVIEW`; `request_changes` writes a
  `human_review` artifact and the next `DEVELOPMENT` run receives it in its
  inputs.

**Component**
- The diff renderer never uses `dangerouslySetInnerHTML`. Worth an explicit
  assertion or a lint rule scoped to the component — it is the kind of thing a
  later "let's add highlighting" change quietly introduces.

---

## 14. Phasing

**Phase A — `CODE_REVIEW` only.** New stage, role, prompt, artifact, plus the
QA narrowing (§5) and the state-machine switch fix (§8.1). No UI beyond a new
board column and a new artifact tab, both of which the existing components
handle generically. Independently valuable.

**Phase B — the diff viewer**, as a read-only tab on the task detail page for
any task past `DEVELOPMENT`. Useful on its own — being able to see what the
Developer actually did, without opening GitHub, is worth having whether or not
a gate exists.

**Phase C — `HUMAN_CODE_REVIEW`**, which is then mostly wiring: the flag, the
gate, the third decision kind, and the feedback artifact. It depends on B for
the screen and on A for the report shown alongside the diff.

---

## 15. Open questions

1. **Should the agent code review be optional too?** It is unconditional in this
   spec. A `codeReviewEnabled` setting is trivial to add, but every optional
   stage doubles the number of pipeline shapes to reason about and test. Worth
   it only if the cost turns out to be unjustified for small tasks — which
   `/usage` will answer after a few runs.
2. **Line-level comments.** Out of scope here: a single Markdown comment per
   decision is enough to unblock the Developer. Real inline comments need a
   `review_comments` table keyed by file and line, a threading model, and a way
   to render them into the Developer's prompt — a separate feature roughly the
   size of this one.
3. **Should `CODE_REVIEW` use `MODEL_HEAVY` by default?** It is the stage where a
   stronger model most plausibly pays for itself. Left at `MODEL_DEFAULT` here
   because it is one field in Settings and the answer is measurable rather than
   arguable.
4. **Rejection from `HUMAN_CODE_REVIEW` when the rework budget is spent.** The
   task fails, which is correct but abrupt for someone who just asked for
   changes. An alternative is to let a human `request_changes` grant one extra
   cycle beyond the budget, on the grounds that a person has explicitly chosen
   to spend it. Needs a product decision.
5. **Reviewing across rework cycles.** The reviewer sees the full branch diff
   each time, not just what changed since its last pass. That is simpler and
   safer, but on the third cycle it re-reads work it already approved. An
   incremental diff (`HEAD@{previous review}...HEAD`) would be cheaper and is
   feasible — the previous stage run's commit SHA would need recording.
