# Agent Context — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** What actually reaches an agent's prompt. Delivering the
> attachments the user uploaded, giving OpenAI and Gemini the project context
> Claude already gets, letting a rework cycle remember the previous one, and
> making a malformed artifact recoverable instead of fatal.
> **Prerequisite:** the pipeline as built. §6 (prompt editing) depends on
> `spec-audit-trail.md`'s transcript viewer having landed — see §6.1 for why
> that ordering is not negotiable.
> **Related:** `spec-audit-trail.md` (§3 — the persisted prompt, which is what
> makes every change here observable; §5 — artifact versions, which §7 writes
> to); `spec-code-review.md` (§15.5 raised the incremental-review question §5
> answers, and §5 there narrowed QA's scope);
> `spec-mechanical-verification.md` (§8 — the verification result is another
> supplement, added through the same seam as §3);
> `spec-human-in-the-loop.md` (§3.3 — the `reworkInputs` role property this
> spec's §5 also needs, specified there);
> `spec-cost-observability.md` (§5 — model tiers, which §7's profiles select).

---

## 1. Summary

Every agent stage is a fresh session whose prompt is assembled from exactly
three things: the role's system prompt, task metadata, and the Markdown
artifacts the role declares it consumes (`prompt.ts:9-15`, `buildStagePrompt` at
`:89-134`). That is the minimum-context handoff, and it is the product's best
architectural idea — no agent inherits another's transcript.

The problem is not the rule. It is that four things which *should* be in that
prompt are not.

**Attachments reach nobody.** The word "attachment" does not appear in
`execute.ts` or `prompt.ts` at all. `gatherInputs` (`execute.ts:87-113`) iterates
`role.consumes` and nothing else. The user picks a screenshot of the broken
screen or a PDF of the spec, watches it upload against an accept list built for
exactly this purpose (`validation/attachments.ts:8-17`), sees it listed on the
task page, can download it — and no agent has ever seen it. The feature promises
context and delivers a file cabinet.

**Project context is Claude-only.** `buildOptions` sets
`settingSources: ["project"]` (`claude.ts:41-43`), which makes the Claude path
load the *target repository's* own `CLAUDE.md`. The OpenAI and Gemini paths
build the same prompt (`openai.ts:80-83`, `gemini.ts:86-88`, `:102`) with no
equivalent. Switching one role to ChatGPT in Settings silently drops the
repository's conventions. That is a correctness difference between providers
that are presented as interchangeable.

**Rework has no memory.** The Developer does not receive its own previous
`dev_report` — `DEVELOPMENT.consumes` is `["stories", "techplan"]`
(`roles.ts:78`). The reviewers do not receive their own previous report, and
they re-read the *entire* branch diff every pass (`execute.ts:170-179`). On the
third cycle a reviewer re-reviews work it already approved twice, and every
flip-flop burns one of the shared cycles that ends in `FAILED`
(`state-machine.ts:106-116`).

**A malformed artifact kills the task.** `validateArtifact` throws,
`execute.ts:238-245` catches it, marks the run failed with `retryable: false`,
and discards the text the agent produced — after the whole session was paid for.

None of the fixes require weakening the minimum-context rule. Every one of them
passes *artifacts and task input*, never a transcript.

---

## 2. Scope

**In scope**

- Attachments in the prompt, per role, with a per-provider strategy (§3).
- A provider-neutral project-context loader (§4).
- Rework memory: previous own-report, incremental diff (§5).
- Prompt editing from the UI, with per-repository overrides (§6).
- Pipeline profiles, and the cheap subset that is worth building first (§7).
- Bounded repair for a malformed artifact (§8).

**Out of scope**

- Cross-task memory ("what did we learn building the last feature in this
  repo"). §4.5 explains why the repository's own committed conventions are the
  right vehicle and a learned-memory store is not.
- Changing the minimum-context rule. Nothing here passes a transcript between
  stages; §5.2 is explicit about why the incremental diff is not a transcript.
- The mechanical verification result as prompt input —
  `spec-mechanical-verification.md` §8 owns it and uses the same `supplements`
  seam §3.4 describes.
- Persisting the assembled prompt. `spec-audit-trail.md` §3 owns it. This spec
  assumes it, because every change here is otherwise unobservable.

---

## 3. Attachments in the prompt

### 3.1 What exists

Attachments are validated against a fixed MIME allow-list — PNG, JPEG, GIF,
WebP, PDF, JSON, XML (`validation/attachments.ts:8-17`) — read fully into memory
(`:62`), and stored as a BLOB on a row cascading from the task
(`schema.ts:135-149`). The schema comment at `:126-134` explains the choice
carefully: a `CREATED` task has no workspace, and the workspace is deleted on a
retention timer, so neither is a home for something the brief treats as part of
the task's permanent record.

Everything about that is right. The pipeline just never reads it.

### 3.2 Which roles receive which attachments

Not every role should get every file. A 4 MB screenshot in the Code Reviewer's
prompt is cost with no benefit; the same screenshot in the Stakeholder's prompt
is the entire point.

Attachments are **task input**, so the roles that receive them are the ones
reasoning about *what to build*, not the ones reasoning about *what was built*:

| Role | Receives | Why |
|---|---|---|
| Stakeholder | all | It has no repository access at all (`roles.ts:42`); attachments are its only context beyond the text |
| Product Owner | all | Writes the acceptance criteria the files usually describe |
| Architect | text/structured only | A spec PDF or JSON schema informs the plan; a screenshot rarely does |
| Developer | all | Implements against the mock-up |
| Code Reviewer, QA, Homologation | none by default | They review against `stories.md`, which already encodes what the attachments said |

Expressed as a role property beside `consumes` and `produces`, so the rule lives
where every other input rule lives:

```ts
/** Which attachment kinds reach this role's prompt. */
attachments: "all" | "documents" | "none";
```

Homologation is the arguable exclusion — it checks acceptance criteria, and a
mock-up is evidence. §11.2 leaves it open rather than guessing.

### 3.3 How each kind is rendered

Three kinds, three treatments:

- **JSON / XML** — decoded as UTF-8 and inlined in a fenced block, truncated
  with `truncateForPrompt` (`prompt.ts:137-142`), which already exists for
  exactly this and marks how much was cut.
- **PDF** — text extracted server-side and inlined the same way. Not passed as
  a binary document block: only one of the three providers would accept it, and
  a spec PDF's value is its text.
- **Images** — passed as a native image content block where the provider
  supports it, and otherwise announced but not sent (§3.5).

### 3.4 The seam already exists

`StagePromptInput` has a `supplements` array —
`Array<{ label: string; body: string; fenced?: boolean }>`
(`prompt.ts:31`) — rendered as sections by `buildStagePrompt` (`:121-124`). It
is how the branch diff already reaches QA and the Code Reviewer
(`execute.ts:168-188`).

Text-shaped attachments need nothing new: they become supplements, with the
filename as the label. That is the whole implementation for JSON, XML and
extracted PDF text.

### 3.5 Images need a real contract change

`supplements` is `string`-typed, and `RunStageOptions.prompt` reaches each
provider as one assembled string (`claude.ts:74`, `openai.ts:82`,
`gemini.ts:87`). An image cannot travel that way.

`StagePromptInput` gains a parallel field:

```ts
/** Binary inputs a provider may render as native content blocks. */
media?: Array<{ filename: string; mimeType: string; data: Buffer }>;
```

and each provider decides:

| Provider | Handling |
|---|---|
| Claude | The prompt to `query()` becomes a content-block array rather than a string |
| OpenAI | An image part in the user message's content array (`openai.ts:80-83`) |
| Gemini | An `inlineData` part alongside the text part (`gemini.ts:86-88`) |
| — fallback | Announce it: "An image `mock.png` was attached but this provider is not configured to receive it." |

The fallback matters more than it looks. Silently dropping an image would
reproduce the exact defect this spec exists to fix, one layer down: the user
attaches a file, the product accepts it, and nothing says it went nowhere.

### 3.6 Size

An unbounded BLOB in a prompt is a bill. The caps:

- Per attachment: 200 KB of extracted text, truncated with a marker.
- Per stage: 500 KB of attachment text total, and at most 5 images.
- Above either, the remaining files are listed by name and size only, with a
  line saying they were omitted for size.

These are per-stage rather than per-task because the same attachment is sent to
several roles, and a per-task budget would make the limit depend on which stage
happened to run first.

---

## 4. Project context, for every provider

### 4.1 The asymmetry

`settingSources: ["project"]` (`claude.ts:43`) is one line, and the comment
beside it is precise about the intent: "Load the target repository's own
CLAUDE.md, but nothing from the host machine's user settings."

The OpenAI and Gemini paths have no equivalent because their SDKs are not
coding-agent harnesses — they are model clients with a tool loop bolted on in
`openai.ts` and `gemini.ts` (`run-stage.ts:7-14` describes exactly this
difference). There is no setting to pass; the file has to be read and injected.

The result today: a user who switches `DEVELOPMENT` to ChatGPT in Settings gets
an agent that ignores the repository's stated conventions, with no warning. The
Settings screen presents providers as a per-role dropdown of equals
(`settings-form.tsx`, provider select per stage), and `docs/llm-providers.md`
documents behaviour differences — but a silently-dropped context file is a
correctness bug, not a documented difference.

### 4.2 A provider-neutral loader

```ts
// src/server/pipeline/project-context.ts
export function loadProjectContext(workspacePath: string | null): string | null;
```

Reads, in order, the first that exists at the workspace root: `AGENTS.md`,
`CLAUDE.md`, `.github/copilot-instructions.md`. Returns the content, capped, or
`null`.

`AGENTS.md` goes first because it is the vendor-neutral convention — and because
this very repository uses it: its `CLAUDE.md` is a one-line `@AGENTS.md`
include, which the Claude path resolves and the others could not.

The result is injected as a supplement labelled "Repository conventions", for
**every** provider including Claude.

### 4.3 Double-loading on the Claude path

If Claude loads `CLAUDE.md` through `settingSources` *and* receives it as a
supplement, it arrives twice. Three options:

- Drop `settingSources: ["project"]` and use the loader everywhere. Uniform, and
  loses whatever else the SDK's project settings provide.
- Keep `settingSources` and skip the supplement for Claude. Preserves SDK
  behaviour, and re-introduces the asymmetry for `AGENTS.md`, which the SDK does
  not read.
- Keep `settingSources` and inject only the files the SDK did not load.

**Take the third.** The loader reports which file it used; on the Claude path,
`CLAUDE.md` is skipped as a supplement (the SDK has it) and `AGENTS.md` is
injected. This is more conditional logic than the alternatives and it is the
only one that leaves both providers with the same information.

### 4.4 Roles without a workspace

The Stakeholder runs with `needsWorkspace: false` (`roles.ts:46`) and
`workspacePath === null`, and the guard denies it every tool
(`guardrails.ts:178-180`). There is no clone to read conventions from, and it is
reasoning about business intent rather than code. It receives no project
context, which is correct and worth stating so nobody adds it later.

### 4.5 Why not cross-task memory

The obvious extension is a store of lessons carried between tasks in the same
repository — "last time, the test command was X".

Rejected. The right place for a durable convention is the repository's own
`AGENTS.md`, committed and reviewed like everything else. A hidden per-repo
memory in this product's SQLite file would be invisible to the humans working in
that repository, unversioned, unreviewable, and would silently diverge from what
the code actually does. §4.2 makes the visible mechanism work; that is the
feature.

---

## 5. Rework memory

### 5.1 What each role is missing on a second pass

`gatherInputs` appends the reviewers' reports when `stage === "DEVELOPMENT" &&
attempt > 1` (`execute.ts:105-110`). That is the only rework-aware input in the
product. So:

- The **Developer** on attempt 3 sees `stories`, `techplan`, and the latest
  reports — but not what it said it did on attempts 1 and 2. It rediscovers its
  own reasoning every cycle.
- The **Code Reviewer** and **QA** on attempt 3 see the full branch diff again
  (`execute.ts:170-179`, computing `origin/base...HEAD`), and not their own
  previous report. They re-review approved work, and nothing anchors them to
  their earlier verdict — which is how a reviewer approves in one cycle what it
  rejected in the last.

Each flip-flop consumes a `DEVELOPMENT` attempt against `reworkMaxCycles`
(`state-machine.ts:108`), so a reviewer with no memory is not just wasteful — it
is the mechanism by which tasks reach `FAILED`.

### 5.2 The incremental diff

`spec-code-review.md` §15.5 already scoped this and identified the missing
piece: the previous review's commit SHA is not recorded.

Add it — one nullable column on `stage_runs`, written when a reviewing stage
completes:

```ts
addColumn(sqlite, "stage_runs", "reviewed_head_sha", "TEXT");
```

On attempt N > 1, the reviewer receives **two** supplements:

1. "Changes since your last review" — `git diff <reviewed_head_sha>...HEAD`,
   which is what it needs to act on.
2. "Full branch diff" — unchanged, truncated as today, so it retains the
   context to judge whether a fix broke something it already approved.

The incremental diff first, because it is the smaller and more actionable of the
two, and truncation (`MAX_DIFF_CHARS`, `execute.ts:49`) bites the second one.

This is not a transcript. It is `git diff` output — the same class of input the
reviewer already receives, over a narrower range.

### 5.3 Own previous report

Each role's own previous artifact, added through the `reworkInputs` property
`spec-human-in-the-loop.md` §3.3 introduces:

| Role | `reworkInputs` |
|---|---|
| `DEVELOPMENT` | `code_review_report`, `qa_report`, `human_review`, **`dev_report`** |
| `CODE_REVIEW` | **`code_review_report`** |
| `QA` | **`qa_report`** |
| `ARCHITECTURE` | `human_review` (from §3.3 of that spec) |

Bolded entries are new. `latestArtifact` (`service.ts:495-505`) returns the
newest of a type, which on a rework cycle is the previous attempt's — exactly
what is wanted, with no query change.

One caveat: the Developer receiving its own previous `dev_report` risks it
restating rather than reconsidering. The prompt framing matters — the supplement
is labelled "What you reported last time, which the reviewer rejected", not
"your previous report".

### 5.4 A cheaper alternative that was rejected

Raising `reworkMaxCycles` would reduce `FAILED` outcomes without any of this
work. It was rejected because it treats the symptom: more cycles of an agent
with no memory is more spend for the same flip-flop, and the ceiling exists to
bound exactly that.

---

## 6. Editing prompts

### 6.1 Why this comes after the transcript viewer

Role system prompts are the largest quality lever in the product — seven
Markdown files under `prompts/`, loaded by `loadSystemPrompt`
(`prompt.ts:39-47`) and cached per process. Changing one today requires
filesystem access and a worker restart: `invalidatePromptCache` exists
(`prompt.ts:50-52`) and is called by **zero** production code. `README.md`
documents the restart requirement honestly rather than hiding it.

An editor is therefore obviously valuable, and must still not be built first.

Editing a prompt without being able to see its effect is blind tuning. Today the
only forensic surface is the live log — capped at 400 lines client-side
(`live-log.tsx:32`), tool calls reduced to a one-line summary with no input or
result (`claude.ts:93-99`) — and the assembled prompt is not persisted at all,
so a user cannot even reconstruct what a previous run received. Shipping an
editor into that would produce a product where users change prompts, observe
different outcomes, and have no way to attribute the difference.

`spec-audit-trail.md` §3 (persist the prompt) and §4 (the transcript viewer)
are the prerequisites, and this section should not be scheduled before them.

### 6.2 Storage

Prompts stay files on disk and remain the default. An override is a row:

```sql
CREATE TABLE IF NOT EXISTS prompt_overrides (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,  -- NULL = global
  content_md TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_overrides_scope_idx
  ON prompt_overrides(stage, coalesce(repo_id, ''));
```

Resolution order: repo override → global override → the file. Keeping the files
as the base means a fresh install works with no rows, `git diff` on `prompts/`
still shows the shipped defaults, and deleting an override is a real revert.

Rows are append-only per scope in spirit — an edit writes a new row and the
newest wins — so the history is available to `spec-audit-trail.md`'s version
viewer without a second mechanism.

### 6.3 Cache invalidation across two processes

`promptCache` is a module-level `Map` (`prompt.ts:36`) in whichever process
loaded it. The web process saves the override; the worker holds the stale cache.
This is the same two-process problem `spec-spend-and-operational-control.md` §6.3
solves for cancellation, and it has the same answer: the worker polls.

Cheapest correct form: cache keyed by a version counter read at the start of
each stage run. One integer read per stage — negligible against an agent session
— and it removes the restart requirement `README.md` currently documents.
`invalidatePromptCache` finally acquires a caller.

### 6.4 Guardrails are not negotiable from the prompt

A prompt is instructions to a model; it is not a permission grant. The
`canUseTool` guard (`guardrails.ts:169-208`) reads `role.allowedTools`,
`role.canWrite` and the workspace path from `ROLES` — never from prompt text.
An override cannot widen what a role may do, and the editor says so in the UI,
because a user who believes otherwise will write instructions that are silently
denied and blame the model.

---

## 7. Pipeline profiles

### 7.1 The cost of uniformity

Every task runs seven agent sessions with 218 turns budgeted by default
(`settings/store.ts:82-92`). Fixing a typo in a label costs a brief, user
stories, a technical plan, a development session, a code review, a QA pass and a
homologation report.

The only conditional stage today is `PLAN_GATE`, and only when the Architect
rates criticality low and the setting is on (`orchestrator.ts:67-69`). That is
the correct *shape* — a per-stage condition evaluated from data the pipeline
already produces — and it is applied to exactly one gate.

### 7.2 Build the cheap version first

A full profile system means named bundles selecting which of seven stages run,
which multiplies the number of pipeline shapes to reason about and test — the
concern `spec-code-review.md` §15.1 raised when it declined to make code review
optional.

The cheap version, which delivers most of the value:

```ts
codeReviewEnabled: "always" | "auto" | "never";   // default "always"
```

`"auto"` skips `CODE_REVIEW` when the Architect rated `difficulty: "S"` **and**
`criticality: "low"` — the same two fields the plan gate already keys on, both
already extracted and persisted (`extractPlanEstimate`, `artifacts.ts:164-178`;
`setTaskEstimate`, `service.ts:410-416`). One transition in
`state-machine.ts:191-195` becomes conditional. No new stage, no new profile
concept, and it is measurable: `/usage` shows what code review costs per task,
so the decision to enable `"auto"` can be made from data.

The full profile system stays an open question until that number exists (§11.4).

### 7.3 What must not become optional

`STAKEHOLDER_REFINEMENT` and `PO_REFINEMENT` produce `brief.md` and
`stories.md`, which are `consumes` inputs for almost every later role
(`roles.ts:53-118`) — and a missing input is a hard, non-retryable failure
(`execute.ts:94-98`). Any profile that skips a producing stage has to also
rewrite the consumers' contracts, which is precisely the combinatorial problem
worth avoiding. Profiles may skip *reviewing* stages; they may not skip
*producing* ones.

---

## 8. Malformed artifacts

### 8.1 What happens today

```ts
// execute.ts:238-245
let content: string;
try {
  content = validateArtifact(role.produces, result.finalText);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  markStageRunStatus(stageRunId, "failed", { error: message });
  throw new StageJobError(message, false);
}
```

`retryable: false` is deliberate and the comment above it is right: re-running
the same prompt is unlikely to produce a differently-shaped document, and
advancing with a malformed artifact would poison every later stage.

What is wrong is what happens to the text. `result.finalText` — a complete
document that a human could fix in fifteen seconds — is discarded, and the whole
session's cost is spent for nothing.

### 8.2 The three failure modes are not alike

`validateArtifact` (`artifacts.ts:114-137`) produces three kinds of problem:

| Problem | Fixable by asking again? |
|---|---|
| Missing required `## Section` | Yes — it is a formatting error, and the contract is already in the system prompt (`prompt.ts:76-84`) |
| Empty document | Sometimes — usually a symptom of a session that ended badly |
| Over `MAX_ARTIFACT_CHARS` (40,000, `artifacts.ts:20`) | **No** — asking for reformatting produces the same length |

The third is the one that gets designed wrong. Its repair instruction is not
"follow the contract" but "compress this to under N characters, keeping every
required section" — a different request.

### 8.3 A bounded repair turn

One additional model call, in the same session where the provider supports it,
with a prompt naming the exact problems `ArtifactValidationError` already
carries (`artifacts.ts:79-87` — it holds `problems: string[]`, which is why this
is cheap).

- Exactly **one** attempt. A loop against a model that cannot follow a format is
  a spend loop.
- The repair turn's tokens and cost are added to the stage run, via the same
  partial-cost accounting `spec-spend-and-operational-control.md` §5.4 fixes.
- If the repair fails, the stage fails as it does today.

### 8.4 Keeping the rejected text

Whether or not the repair succeeds, the produced text is persisted so it is not
lost. It cannot go in `artifacts` — every consumer of that table assumes valid
content, and `latestArtifact` would hand a malformed document to the next stage.

It goes on the stage run:

```ts
addColumn(sqlite, "stage_runs", "rejected_output", "TEXT");
```

The failed run in the timeline then offers "View what the agent produced", and —
since `spec-human-in-the-loop.md` §4.3 already builds a validating artifact
editor for the plan gate — an "Accept with my edit" action that runs the same
validation and writes a human-authored artifact, letting the task continue.

That reuse is the argument for doing this after §4 of that spec rather than
before.

---

## 9. Data model summary

One new table in `bootstrap.sql.ts` (`CREATE TABLE IF NOT EXISTS`, safe on both
fresh and existing databases):

- `prompt_overrides` (§6.2)

One appended `MIGRATIONS` entry (`migrations.ts:39-64`):

```ts
{
  name: "rework memory and rejected artifact output",
  up: (sqlite) => {
    addColumn(sqlite, "stage_runs", "reviewed_head_sha", "TEXT");
    addColumn(sqlite, "stage_runs", "rejected_output", "TEXT");
  },
}
```

Settings blob additions (merged against defaults, `settings/store.ts:113-126`,
no migration):

```ts
codeReviewEnabled: "always" | "auto" | "never";   // default "always"
attachmentsInPrompts: boolean;                     // default true
```

`updateSettingsSchema` (`validation/schemas.ts:168-178`) must declare both.
Note that this schema already silently drops `reworkMaxCycles` and
`humanCodeReviewDefault` — `z.object` strips unknown keys and neither is
declared — so any new field added without fixing that inherits the same fate.

No change to `ROLES`' shape beyond three new properties (`attachments`,
`reworkInputs`, and nothing else), all of which are TypeScript-only.

---

## 10. Test plan

**Prompt assembly (pure)**
- A JSON attachment becomes a supplement with the filename as its label and is
  truncated at the cap with a marker.
- A role with `attachments: "none"` receives none; `"documents"` receives the
  JSON and the PDF text but not the PNG.
- Over the per-stage cap, the remaining files are listed by name and size and
  the prompt says so.
- `loadProjectContext` prefers `AGENTS.md` over `CLAUDE.md`, returns `null` for
  a workspace with neither, and is not called for a null workspace path.
- On the Claude path, `CLAUDE.md` is not injected as a supplement while
  `AGENTS.md` is; on OpenAI and Gemini, both are.

**Providers (injected fakes)**
- Each of the three receives an image in its native shape when `media` is
  populated; the fallback announces the file when the provider is not wired.
- Parameterised over all three so a new provider cannot silently drop media.

**Rework inputs (temp DB)**
- `DEVELOPMENT` attempt 2 receives the previous `dev_report`; attempt 1 does
  not.
- `CODE_REVIEW` attempt 2 receives its own previous report and an incremental
  diff supplement; attempt 1 receives only the full diff.
- `reviewed_head_sha` is written when a reviewing stage completes, and the
  incremental range uses it.
- A reviewing stage with a null `reviewed_head_sha` (first pass, or a run from
  before this change) falls back to the full diff without erroring.

**Artifact repair**
- A missing-section document is repaired by one turn and the stage advances.
- Repair is attempted exactly once; a second failure fails the stage with
  `retryable: false`, as today.
- An over-length document receives the compression instruction, not the
  formatting one.
- `rejected_output` is persisted in every failing case.
- The repair turn's cost is added to the stage run.

**Prompt overrides**
- Resolution order: repo override wins over global, global over the file.
- Deleting an override reverts to the file's content.
- The worker picks up an override written by the web process without a restart.
- An override cannot grant a tool: a `CODE_REVIEW` override instructing the
  agent to write a file is still denied by `canUseTool`.

**Integration**
- Full pipeline with `codeReviewEnabled: "auto"` and an `S`/`low` estimate skips
  `CODE_REVIEW`; with `M`/`low` it runs.
- **Regression:** with the default `"always"`, every existing pipeline test
  passes unchanged.

---

## 11. Phasing

**Phase A — attachments, text kinds only (§3.1-§3.4, §3.6).** Uses the existing
`supplements` seam, needs no contract change and no schema change, and fixes the
feature that most clearly misleads the user today. Images (§3.5) follow
separately because they touch all three providers.

**Phase B — project-context parity (§4).** One small module and three call
sites. It closes a correctness gap between providers the Settings screen
presents as equals.

**Phase C — rework memory (§5).** One column, the `reworkInputs` table, and a
second supplement. Directly reduces `FAILED` outcomes and spend, and is
measurable in `/usage`.

**Phase D — artifact repair (§8).** Depends on `spec-human-in-the-loop.md` §4.3
for the editor half; the repair turn and `rejected_output` can land without it.

**Phase E — `codeReviewEnabled: "auto"` (§7.2).** One conditional transition.
Deliberately not the full profile system.

**Phase F — prompt editing (§6).** Last, and gated on
`spec-audit-trail.md` §3-§4. Not because it is hard, but because shipping it
earlier would be shipping a tuning tool with no feedback loop.

---

## 12. Open questions

1. **Does the Developer receiving its own previous report help or entrench?**
   §5.3 assumes memory reduces flip-flops. The opposite risk is real: a model
   shown its own previous reasoning tends to defend it, and the rework cycle
   exists precisely because that reasoning was wrong. The framing in §5.3 is a
   mitigation, not evidence. This is measurable — compare rework counts before
   and after — and worth measuring rather than assuming.
2. **Should homologation receive attachments?** §3.2 excludes it. It checks
   acceptance criteria, and when the criteria say "matches the attached
   mock-up", excluding the mock-up makes the check impossible. Including it adds
   an image to a stage that runs on the light model tier
   (`settings/store.ts:65`) and reads only `Read` (`roles.ts:112`). The answer
   probably depends on how often stories reference attachments, which is
   observable once Phase A ships.
3. **Is PDF text extraction worth a dependency?** §3.3 extracts text
   server-side, which means a PDF library in the worker. The alternative — send
   the PDF as a document block on the one provider that accepts it, and nothing
   elsewhere — reintroduces the provider asymmetry §4 exists to remove. A third
   option is to reject PDFs at upload until this is decided, which is at least
   honest, and is worth considering given the accept list already promises to
   take them.
4. **Named profiles at all (§7.2).** The `"auto"` code-review flag is defended
   as the cheap subset. Whether the full Quick/Standard/Full concept is ever
   worth the pipeline-shape explosion depends on data that does not exist yet:
   if most tasks are `S`/`low`, a Quick profile skipping three stages is a large
   saving; if most are `M`+, it is a setting nobody uses.
5. **Per-repository prompt overrides may be the wrong axis.** §6.2 scopes an
   override to `(stage, repo)`. But the thing that actually varies by repository
   is *conventions*, which §4 already delivers through `AGENTS.md` — a file the
   repository's own team can review. A per-repo prompt override is a second,
   invisible channel for the same information, and it may be better to ship
   global overrides only and let §4 carry the per-repo case.
6. **Should a repaired artifact be marked?** §8.3 lets a repair turn produce the
   artifact that advances the pipeline, indistinguishable from a first-attempt
   one. Given §4.4 of `spec-human-in-the-loop.md` adds an `authored_by` column
   for human edits, marking machine repairs in the same field costs nothing —
   but it is unclear whether anyone would ever act on the distinction.
