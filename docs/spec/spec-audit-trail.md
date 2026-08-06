# Audit Trail — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Make the record the pipeline already writes readable — a per-run
> transcript viewer, the prompt that was actually sent, artifact version history,
> a file list that survives workspace cleanup, a one-file export, and retention
> for transcripts that today grow without bound.
> **Prerequisite:** the pipeline described in `spec-esteira-multiagente.md`, as built.
> **Related:** `spec-code-review.md` (§10.1 specified the `diff_summary` artifact
> this spec finally builds — §8), `spec-task-queue.md` (§7.2, the cascade that
> makes a task delete take its whole record with it), `spec-cost-forecast.md` (§3
> reads `stage_runs`; §4 gives it the model column it lacks),
> `spec-multi-provider-repositories.md` (§8, the guardrails §10 extends),
> `spec-execution-honesty.md` (the live log is the surface this replaces for
> forensics), `spec-retry-recovery.md` (a retry's failed attempt is the transcript
> most worth keeping — §12.2), `spec-mechanical-verification.md` and
> `spec-homologation-verdict.md` (both produce evidence belonging in the export).

---

## 1. Summary

`README.md:51-53` sells the trail as a product feature: *"The same trail is what
lets you ask later why something was built rather than only what changed."* It is
written and never opened.

- **Transcripts are write-only.** `saveTranscript` (`src/server/tasks/service.ts:521-534`)
  is the only code in the repository that touches `agent_runs`. The contract type
  says so out loud — *"nothing reads this back into the pipeline — it is a JSON
  blob for humans"* (`src/server/pipeline/providers/types.ts:21-27`) — and
  `schema.ts:260-268` exports a row type for nine of the eleven tables;
  `agent_runs` and `settings` are the two without one.
- **The prompt is never persisted at all.** `buildSystemPrompt` and
  `buildStagePrompt` (`src/server/pipeline/prompt.ts:62-134`) hand a string to the
  provider and it is gone.
- **Artifact history collapses.** `listLatestArtifacts` (`service.ts:508-519`)
  reduces to the newest row per type, so the UI cannot show attempt 1 against
  attempt 3.
- **The diff dies with the workspace.** `executeCleanup` (`execute.ts:404-412`)
  removes the clone after `workspaceRetentionDays`. `spec-code-review.md:352`
  already specified a `diff_summary` artifact at `DELIVERY`. It was not built.
- **The live log is the only forensic surface, and it is lossy by design.** Capped
  at 400 lines client-side (`src/components/live-log.tsx:32`), tool calls reduced
  to a 240-character one-liner with no input and no result
  (`providers/claude.ts:93-99`, `providers/tool-runtime.ts:26-44`), every denial
  given the same generic string regardless of which rule fired
  (`claude.ts:110-116`).

This spec does not change how transcripts are stored — the provider-specific
`unknown[]` is the right call and stays. It adds a **normaliser** that renders all
three shapes through one view model, the columns that record what a run was given,
and the surfaces that read it back.

---

## 2. Scope

**In scope**

- System prompt, user prompt, model and provider, persisted per stage run (§4).
- A normalised transcript view model covering Claude, OpenAI and Gemini (§5).
- A per-run transcript viewer with paginated delivery (§6).
- `listArtifacts(taskId, type)`, a version switcher in `artifact-tabs.tsx`, and a
  diff between two versions (§7).
- The `diff_summary` artifact at `DELIVERY` (§8).
- A single-file export of one task's complete record (§9).
- Redaction, at write time and at read time (§10).
- Retention for `agent_runs`, and where it is configured (§11).

**Out of scope**

- Streaming a transcript while the stage runs. The array is assembled in provider
  memory and only reaches the database at `execute.ts:221-225`; making it live
  means a second write path and a second consistency problem. §15.5.
- Redacting artifact bodies. They are the deliverable, and mangling `techplan.md`
  because it contains the string `API_KEY=` is worse than the exposure. §15.3.
- Importing an export into another instance. It is a record, not a backup — §9.2.
- Full-text search across transcripts. The question here is "what happened in
  *this* run", not "which run mentioned X". §15.4.
- Any change to how the diff is read. `src/server/git/diff.ts` and
  `/api/tasks/:id/diff` stay as they are; §8 only persists the cheap index.

---

## 3. What is recorded today, and what is lost

```
   stage begins                                               stage ends
        │                                                          │
        ▼                                                          ▼
  createStageRun ──► buildSystemPrompt ──► runStage ──► saveTranscript
  (stage_runs)       buildStagePrompt      (provider)   (agent_runs)
        │                    │                 │             │
   persisted           NOT PERSISTED     NOT PERSISTED   persisted,
   (id, stage,          ← the ask         ← unless the   never read
    attempt,                                run succeeds
    max_turns)                              (§12.2)
```

Of the questions a user actually asks, one is answerable: *what did this task cost,
per stage* — because `usageByStage` (`service.ts:572-585`) reads a column someone
wrote at `execute.ts:229-233` instead of leaving it in a blob. *Which model wrote
this* is recoverable only by parsing a `stage_started` event payload
(`events/store.ts:20`). *What was the Architect told*, *what did the agent read*,
*what did version 1 of the plan say* and *why was that tool call blocked* have no
answer at all. That column-not-blob pattern is what the rest of this spec follows.

---

## 4. The prompt belongs on `stage_runs`, not in `agent_runs`

```sql
ALTER TABLE stage_runs ADD COLUMN system_prompt TEXT;
ALTER TABLE stage_runs ADD COLUMN user_prompt   TEXT;
ALTER TABLE stage_runs ADD COLUMN model         TEXT;
ALTER TABLE stage_runs ADD COLUMN provider      TEXT;
```

Nullable: rows written before this migration have no prompt, and inventing one
would be a lie.

**Not a row in `agent_runs`.** `agent_runs` is written *after* the provider returns
(`execute.ts:221-225`); the prompt exists *before* it is called. Putting the prompt
there means the case where it matters most — a stage that failed — is the case
where it is missing, because `executeAgentStage` catches the provider error at
`execute.ts:215-219` and throws without ever reaching `saveTranscript`.
`stage_runs` already exists at that moment (`createStageRun`, `orchestrator.ts:92`)
and is already updated mid-run (`updateStageRun`, `execute.ts:229-233`).

The write goes immediately before `runStage` is invoked (`execute.ts:192-194`),
taking both strings plus the two configuration values already in hand at
`execute.ts:128-130`. The builders then run twice per stage — once here, once
inside the provider (`claude.ts:33,74`; `openai.ts:81-82`; `gemini.ts:87,102`) —
but they are pure string assembly over a cached file (`prompt.ts:36-47`), so the
duplication costs nothing measurable and beats threading built strings through
`RunStageOptions`, whose purpose is provider dispatch.

**Size.** The user prompt embeds consumed artifacts verbatim (`prompt.ts:112-119`),
each capped at 40 000 characters (`artifacts.ts:20`), plus the diff supplement
capped at 60 000 (`execute.ts:49`). `CODE_REVIEW` consumes three artifacts
(`roles.ts:92`) plus the full diff — 180 KB. *Corrected:* that is not the worst
case. A `DEVELOPMENT` rework consumes `stories` and `techplan` and has
`code_review_report`, `qa_report` and `human_review` appended by `gatherInputs`
(`execute.ts:105-110`) — five artifacts, roughly 200 KB, with no diff supplement.
That duplicates bodies already in `artifacts`. Store it anyway: **reconstructing
the prompt from the artifacts is precisely the reconstruction that can be wrong**,
and a record that must be recomputed to be read is not a record.
`MAX_PROMPT_CHARS = 400_000`, with the marker `truncateForPrompt`
(`prompt.ts:137-142`) already uses, bounds the row. The system prompt is ~5 KB and
near-identical across runs of one role, and is stored per run regardless, because
`invalidatePromptCache` (`prompt.ts:50-52`) exists precisely so a user can edit
`prompts/*.md` between runs — which makes "which version of the role prompt ran"
unanswerable without a copy. A content-addressed `prompt_texts` table keyed by
SHA-256 would deduplicate it, and is rejected as a table and a join to answer what a
nullable TEXT column answers directly.

**`model` and `provider` do not exist today.** The only surviving record of which
model ran is the `stage_started` event payload (`events/store.ts:20`), so
`usageByStage` attributes cost per stage but never per model, and pruning events
would destroy the attribution entirely. All four columns land as a third entry
appended to `MIGRATIONS` (`src/server/db/migrations.ts:39-64`, two entries today)
using the idempotent `addColumn` helper (`migrations.ts:28-37`). Four nullable
`TEXT` columns with no `NOT NULL` and no default is the one
`ALTER TABLE ADD COLUMN` form SQLite accepts without rebuilding the table, so the
migration is a straight append.

*Corrected:* an earlier draft also had the `CREATE TABLE IF NOT EXISTS` bootstrap
(`bootstrap.sql.ts:43-57`) gain the same columns "so both paths converge". It must
not. The paths already converge — `client.ts:29-31` executes `BOOTSTRAP_SQL` and
then `runMigrations` unconditionally, so a brand-new file picks the columns up from
the migration, exactly as it picks up `tasks.require_human_code_review` and the
three `repos` credential columns, none of which the bootstrap declares. Editing the
bootstrap would also contradict `tests/migrations.test.ts:69-79`, which opens a
bootstrap-only database and asserts the migrated column is *absent*: "the bootstrap
does not create it — that is the whole reason migrations exist rather than editing
the bootstrap DDL."

---

## 5. The transcript normaliser

Storage does not change. `transcript_json` stays a provider-specific `unknown[]`
for the reason `types.ts:21-27` gives: the three SDKs have genuinely different
message shapes, and forcing them into one at write time means lossy conversion
inside the provider modules, where a bug stays invisible until someone reads the
blob a month later. The conversion happens on read, in
`src/server/audit/normalize.ts`.

```ts
export type TranscriptEntry = {
  /** 0-based position in the stored array; stable, and the pagination cursor. */
  index: number;
  role: "system" | "assistant" | "tool" | "user" | "result";
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "meta" | "result";
  /** Rendered body, already redacted (§10). */
  text?: string;
  /** `input` is the full input, not the 240-char summary the live log shows. */
  tool?: { name: string; input: unknown; output?: string; isError?: boolean };
  usage?: { inputTokens: number; outputTokens: number };
  /** Set when the element was not recognised; `text` then holds the raw JSON. */
  unrecognised?: true;
};

export type NormalizedTranscript = {
  provider: LlmProviderId | "unknown";
  entries: TranscriptEntry[];
  /** True when §11's write cap or the retention sweep removed content. */
  truncated: boolean;
};
```

| Provider | Stored element | Mapping |
|---|---|---|
| Claude | one `SDKMessage` per stream frame (`claude.ts:79`) | `system`/`init` → `meta`; `assistant` → one entry per content block (`text`, `thinking`, `tool_use`); `user` → its `tool_result` blocks; `result` → `result` with usage |
| OpenAI | one whole `ChatCompletion` per turn (`openai.ts:100`) | `choices[0].message.content` → `text`; each `tool_calls[]` → `tool_use` with `JSON.parse`d arguments; `usage` → usage |
| Gemini | one `GenerateContentResponse` per turn (`gemini.ts:104`) | each `candidates[0].content.parts[]`: `text` → `text`, `functionCall` → `tool_use`; `usageMetadata` → usage |

**The provider comes from `stage_runs.provider` (§4), not from sniffing the blob.**
Sniffing works — the three shapes are distinguishable — but it fails open: an
unrecognised shape renders as an empty transcript rather than an error. Rows
predating §4 fall back to sniffing and report `"unknown"` in the UI.

**An unrecognised element is never dropped.** It becomes an entry with
`unrecognised: true` carrying the raw JSON. A normaliser that silently discards
what it does not understand produces a plausible, incomplete record — the same
fail-closed instinct `extractReviewVerdict` (`artifacts.ts:187-192`) applies to
verdicts.

**Two of the three transcripts are half a transcript.** `openai.ts:100` pushes the
model's *response*; the actual conversation — system message, user prompt, every
tool result — lives in the local `messages` array (`openai.ts:80-83`, `114`, `156`)
and is discarded when the function returns. `gemini.ts:104` does the same against
`contents` (`gemini.ts:86`, `119`, `163`). Claude's is complete, because
`claude.ts:79` pushes every frame including the `user` frames carrying
`tool_result` blocks. §12.3.

---

## 6. The transcript viewer

`GET /api/tasks/:taskId/runs/:runId/transcript?offset=0&limit=50`:

```jsonc
{
  "stageRun": { "id": "run_…", "stage": "DEVELOPMENT", "attempt": 2,
                "model": "claude-sonnet-5", "provider": "claude",
                "status": "done", "costUsd": 1.42, "error": null },
  "prompt": { "system": "You are the Developer…", "user": "## Task\n…" },
  "transcript": {
    "provider": "claude", "available": true, "truncated": false,
    "total": 214, "offset": 0, "limit": 50,
    "entries": [
      { "index": 2, "role": "assistant", "kind": "tool_use",
        "tool": { "name": "Read", "input": { "file_path": "src/…/stages.ts" } } },
      { "index": 3, "role": "tool", "kind": "tool_result",
        "tool": { "name": "Read", "output": "1\timport …", "isError": false } }
    ]
  }
}
```

**`runId` is scoped to `taskId`.** A run belonging to another task is a 404, not a
403 — the same shape `deleteAttachment` already uses to make a foreign id
un-matchable (`service.ts:226-233`). Without it, run ids are guessable identifiers
into an unscoped table.

### 6.1 Pagination over a single blob

`transcript_json` is one column: there is no SQL-level pagination, and a
`transcript_entries` table to get it means a second copy of the largest data in the
database plus a backfill. **The blob is parsed and normalised on read, then
sliced.** With `MAX_TRANSCRIPT_BYTES` (§11) capping the stored value at 8 MB, the
worst-case parse is tens of milliseconds on the machine already running an agent.
Pagination is still required, but for the *response*: a 214-entry Developer
transcript with full tool inputs and outputs is not a payload the browser should
receive whole. The parse is memoised per process. *Corrected:* a draft keyed the
memo on `agent_runs.id` alone and claimed it **needs no invalidation**, because
`saveTranscript` (`service.ts:521-534`) only ever inserts and nothing else in the
repository touches `agent_runs` (confirmed — it is the only write site). That
holds today and **§11 breaks it**: the retention sweep `UPDATE`s
`transcript_json` to a tombstone, from the worker, where the web process's memo
cannot see it, and the sweep changes no other column a reader could compare. So
the key is `(id, length(transcript_json))` — a scalar the viewer already selects
for the row header — and a tombstoned row misses the memo and re-parses. A pruned
transcript still rendering as if it were there is the one failure this cache can
produce, and it is the one that would be believed.

### 6.2 Where it renders

The Timeline card (`app/(dashboard)/tasks/[id]/page.tsx:143-163` — the page lives
inside the `(dashboard)` route group, not at `app/tasks/`) already renders one
`<li>` per stage run with stage, attempt, duration, tokens and cost; each row's
stage label
becomes a link to **`/tasks/[id]/runs/[runId]`**. That page has three collapsible
sections: **what it was asked** (both prompts, collapsed by default — the user
prompt is the longest thing on the page and the transcript is what people came
for), **what it did** (the paginated transcript), and **what it produced** (the
artifacts whose `stage_run_id` is this run, plus `error` when it failed).

- Entries render as React children. **No `dangerouslySetInnerHTML` and no
  `innerHTML` anywhere in the renderer** — a transcript contains verbatim
  repository file contents, exactly the untrusted-text situation
  `diff-viewer.tsx:10-18` guards against with `tests/diff-viewer-safety.test.ts`
  asserting it. That assertion extends here.
- `tool_use` shows the full input as pretty-printed JSON, collapsed past 20 lines —
  the single biggest gain over the live log, which shows a 240-character summary of
  one field (`tool-runtime.ts:28-44`). `tool_result` shows the output, collapsed
  past 40 lines, error-toned when `isError`. `thinking` renders as a muted
  collapsed block: it is present in Claude frames — `claude.ts:91-92` emits an
  event for it and discards the text — and is the most direct answer to "why did it
  do that".

### 6.3 Denial reasons

`claude.ts:110-116` replaces every permission denial with the literal
`"Blocked by the pipeline sandbox."`, discarding the guard's own message. The guard
produces a specific reason for every rule (`guardrails.ts:130-134`, `150-155`,
`175`, `191`, `199-203`), and the OpenAI and Gemini paths already surface it
verbatim (`openai.ts:153`, `gemini.ts:158`). The Claude path emits the real reason
too, and a denial becomes a transcript entry with `tool.isError: true` — so a
blocked call is in the permanent record rather than only in a live log that has
scrolled past 400 lines.

---

## 7. Artifact version history

Two queries: `listArtifacts(taskId, type)` returning every version newest-first,
and `listArtifactVersions(taskId)` returning
`{ id, type, stageRunId, attempt, createdAt, sizeBytes }` for all of them — joining
`stage_runs` for `attempt` and selecting `length(content_md)` rather than the body.

That distinction matters. `listLatestArtifacts` (`service.ts:508-519`) loads
**every** artifact row's `content_md` for the task and then throws all but the
newest of each type away. Today that is seven rows — one per agent stage
(`roles.ts:36-119`), plus a `human_review` only if a reviewer asked for changes;
after three rework cycles, each re-running Development, Code Review and QA, it is
sixteen rows of up to 40 KB, read on every render of the task detail page
(`app/(dashboard)/tasks/[id]/page.tsx:36`). `listLatestArtifacts` stays — it is what the tabs
render — and the page additionally calls `listArtifactVersions`. Older bodies are
fetched on demand from `GET /api/tasks/:taskId/artifacts/:artifactId`, so the
server-rendered payload stays the size it is today; shipping every version's body
into the RSC payload would put ~120 KB of Markdown on the wire for a screen where
the user reads one document.

**The switcher.** `artifact-tabs.tsx` keys tabs on `artifact.type` (line 64) and
assumes one artifact per type, which `listLatestArtifacts` guarantees. Versions
break that assumption directly: two rows of the same type produce two Radix
triggers with the same `value` (§12.1). The tab set therefore stays one tab per
*type*; version selection is a second control inside the panel.

```
┌ techplan.md ─────────────────────────────────────────────┐
│  ◀  attempt 2 · 14 Mar 09:41  ▶     [latest]  [compare…] │
├──────────────────────────────────────────────────────────┤
│  ## Approach                                             │
```

The panel opens on the newest version, matching today's behaviour. Stepping back
badges the panel as showing an older version — a stale plan read as current is the
failure mode worth designing against. Types with one version show no control.

**Comparing two versions is computed in the browser, with no new dependency.**
Artifacts are capped at 40 000 characters (`artifacts.ts:20`), so a line-level LCS
over roughly 1 000 × 1 000 lines is a single-digit-millisecond operation; a diff
library for one screen, or a server round trip over data the client already holds,
both cost more than twenty lines of LCS. The comparison emits a **synthetic unified
patch string**, which `PatchBody` (`diff-viewer.tsx:87-117`) renders unchanged —
inheriting its gutter markers, its `aria-label`s and its no-raw-HTML guarantee.

---

## 8. The `diff_summary` artifact at `DELIVERY`

`spec-code-review.md:352-356` (§10.1) specified this and it was not built:

> **After workspace cleanup** (`WORKSPACE_RETENTION_DAYS`), the full diff is gone.
> To keep the historical view useful, persist only the cheap part when the task
> reaches `DELIVERY`: the `--name-status` list plus per-file added/removed counts,
> as a `diff_summary` artifact.

A ninth `ArtifactType` with required sections `Summary` and `Files`.
`ARTIFACT_TYPES`, `ARTIFACT_FILENAMES` (`stages.ts:126-150`) and `ARTIFACT_SPECS`
(`artifacts.ts:30-77`) are total records, so the compiler forces all three entries.
The body is a `Summary` list — base branch, head branch, **head commit SHA**,
totals — followed by a `Files` table of `status | path | + | −`, one row per file,
renames rendered as `old → new`.

Built from `readDiffIndex` (`git/diff.ts:143-176`) and `summarizeDiff`
(`git/diff.ts:219-226`), both already exercised by `tests/diff.test.ts`. The head
SHA needs one addition to `workspace.ts` — `git rev-parse HEAD` — and it is the
load-bearing field: after cleanup it is the only thing tying this document to a
commit on the remote.

**When.** In `executeDelivery`, **before** `pushBranch` (`execute.ts:360`), not
after the pull request is opened. The workspace is guaranteed present —
`execute.ts:348-350` fails the stage outright without it — and writing first means
a delivery that fails at the push or at PR creation still leaves a record of what
was about to ship. The current ordering wraps both remote calls in one `try`
(`execute.ts:359-390`); anything written after them is lost exactly when something
went wrong. The write gets its own `try`/`catch` logging a `warn` event: losing the
record is bad, refusing to open a pull request over it is worse.

`saveArtifact` requires a non-null `stage_run_id` (`schema.ts:116-118`). `DELIVERY`
is not an `AgentStage` (`stages.ts:45-53`) but it does get a stage run —
`scheduleStage` creates one for every `run` transition (`orchestrator.ts:87-98`) —
so the `DELIVERY` run is the honest owner, the same argument
`orchestrator.ts:624-630` already makes for `human_review`.

**Reading it back.** `/api/tasks/:id/diff` already returns
`{ available: false, reason, prUrl }` when the workspace is gone
(`app/api/tasks/[id]/diff/route.ts:19-30`). It gains `summary` from the artifact,
and `DiffViewer`'s unavailable branch (`diff-viewer.tsx:206-227`) renders the file
table read-only beside the existing link to the remote.

---

## 9. Export

`GET /api/tasks/:id/export[?transcripts=0]` — `application/json`,
`Content-Disposition: attachment; filename="task-<id>.json"`.

```jsonc
{
  "format": "all-my-fellas/task-record", "version": 1,
  "exportedAt": 1770000000000,
  "redaction": { "applied": true, "patterns": 9, "hits": 3 },
  "task": { "id": "task_7f3c", "title": "…", "description": "…",
            "status": "completed", "difficulty": "M", "criticality": "low",
            "requireHumanCodeReview": true, "prUrl": "https://…" },
  "repo": { "name": "acme/web", "provider": "github", "defaultBranch": "main" },
  "stageRuns": [ { "id": "run_…", "stage": "ARCHITECTURE", "attempt": 1,
                   "status": "done", "model": "claude-sonnet-5",
                   "provider": "claude", "costUsd": 0.184, "error": null,
                   "prompt": { "system": "…", "user": "…" },
                   "transcript": { "provider": "claude", "entries": [] } } ],
  "artifacts": [ { "id": "art_…", "type": "techplan", "stageRunId": "run_…",
                   "attempt": 1, "contentMd": "## Approach\n…" } ],
  "dependsOn": [], "approvals": [], "events": [], "attachments": []
}
```

`dependsOn` carries `{ id, title }` per prerequisite; `approvals` the rows from
`listApprovals` (`service.ts:536-543`); `events` the full per-task log; and
`attachments` metadata plus a `downloadPath`. **Every artifact version is
included**, not just the latest — the record is the point, and `listArtifacts` (§7)
makes it one query per type.

**Why JSON, not a zip of Markdown.** A zip reads better for the artifacts and worse
for everything else. The value of this record is relational: which run produced
which artifact, at which attempt, under which prompt, at what cost. A zip flattens
that into filenames and a naming convention, and recovering the relationships means
parsing the names back. JSON keeps them, is one `JSON.stringify` over rows already
JSON-shaped, and needs no dependency — Node has no built-in zip writer. NDJSON was
rejected: the file is opened once by a person or a script, not streamed.

### 9.1 Deliberately left out

| Omitted | Why |
|---|---|
| Attachment bytes | Tens of megabytes of base64 in a JSON string, for data the per-attachment download route already serves. |
| `credentialRef`, `credentialUsername`, `apiBaseUrl` | `credentialRef` is a variable *name*, never a value (`schema.ts:33-37`), so not a secret — but it says nothing about why the task was built, and `apiBaseUrl` can name an internal host. |
| Full diff / workspace | Megabytes, frequently already deleted. §8's summary is the durable substitute. |
| `jobs` rows | Scheduling mechanics. The retry history that matters shows up as extra `stage_runs` rows. |
| Settings | Global and mutable. The two that affected *this* task are on each run per §4. |

`format` and `version` are in the payload so a consumer can tell what it is
holding, and the download control states in one line what is not included.

### 9.2 Not importable

There is no import route. One means resolving `repo_id` against a different
instance's repos, deciding what a re-imported task's `status` means, and either
preserving or regenerating every id — a feature the size of §7, serving a use case
(moving a task between installs) that a local-first single-user tool does not have.

---

## 10. Redaction

Everything the agent read reaches a transcript: `Read`, `Grep` and `Bash` outputs
are model inputs, and for Claude they are stored frames.

The guardrails block credential-shaped **Bash**: `.env` files (`guardrails.ts:80`),
`id_rsa`/`.ssh/`/`.aws/`/`.npmrc` (`:81`), `printenv` (`:82`), and any variable
whose name matches `TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL` (`:83-94`). **They
do not block the path tools.** `createPermissionGuard` sends `Bash` through
`checkBashCommand` (`guardrails.ts:182-185`) but sends `Read`, `Edit`, `Write`,
`Glob` and `Grep` through `isInsideWorkspace` only (`guardrails.ts:197-205`).
`Read({ file_path: ".env" })` against a repository that committed one is permitted
today and lands verbatim in the transcript (§12.4).

### 10.1 Three layers, in order of value

**1. Close the path-tool hole (structural).** The `DENIED_BASH_PATTERNS` entries
for `.env` and credential material become a shared `CREDENTIAL_PATH_PATTERNS` list
checked against `pathsInInput` (`guardrails.ts:113-122`) for every `PATH_TOOLS`
call.

*Corrected:* `pathsInInput` reads only `file_path`, `path`, `notebook_path` and
`filePath` (`guardrails.ts:115`). That covers `Read`, `Edit`, `Write` and
`NotebookEdit` and **misses `Glob` and `Grep`**, which carry their target in
`pattern` — and `Grep` additionally in `glob` (schemas at `tool-runtime.ts:78-103`).
So this layer also extends the key list with `pattern` and `glob`, or
`Glob({ pattern: "**/.env" })` walks straight through the new check while
`Read({ file_path: ".env" })` is stopped — the same half-closed hole in a new place.

This is the only layer that prevents the exposure rather than masking it, and
it belongs to this feature because this feature is what makes the exposure durable:
a secret in a terminal scrollback is gone on restart; a secret in `agent_runs` is in
a file that gets backed up.

**2. Redact at write time**, in `saveTranscript` and in §4's prompt capture,
applied to the serialised string before it reaches SQLite.

**3. Redact at read time**, in the normaliser and the export — rows written before
this feature are not covered by layer 2 and never will be.

### 10.2 The patterns

`redactRemote` (`workspace.ts:45-49`) already covers a `https://user:secret@host`
remote and an `Authorization: Basic` blob. The new redactor **extends** it rather
than replacing it; `redactRemote` keeps its job of scrubbing error messages
(`execute.ts:216`, `387`).

| Shape | Rule |
|---|---|
| `NAME=value` where `NAME` matches `(TOKEN\|SECRET\|PASSWORD\|PASSWD\|KEY\|CREDENTIAL)` | keep the name, replace the value |
| `"name": "value"` in JSON, same name test | same |
| `ghp_…`, `github_pat_…`, `glpat-…`, `xoxb-…`, `sk-…`, `AKIA[0-9A-Z]{16}` | replace the token |
| `-----BEGIN … PRIVATE KEY-----` … `-----END … -----` | replace the whole block |
| `redactRemote`'s two shapes | unchanged |

The replacement keeps the key and the shape: `API_KEY=[redacted:32 chars]`. A
reader needs to know something was there — a silent deletion produces a record that
looks complete and is not.

### 10.3 This is defence in depth, not a guarantee

Stated plainly, here and in the export UI: a high-entropy blob under a name the
pattern list does not recognise (`clientAuth`, `dsn`, `conn`) is **not** caught; a
credential written in prose — a README, a commit message, a task description a user
pasted — is **not** caught; a secret split across lines, base64'd, or embedded in a
URL path is **not** caught.

The honest claim is: *the shapes we know are masked, and the agent can no longer
read the files that most often hold the ones we do not.* Anything stronger requires
treating every high-entropy string as a secret, which would mangle minified code,
lockfile hashes, git SHAs and UUIDs in every transcript in the system.
`redaction.hits` in the export payload reports how many substitutions were made, so
a user who exports a task from a repository they know holds secrets and sees
`hits: 0` learns the pattern list missed, rather than being reassured.

---

## 11. Retention

`agent_runs` has no expiry. A `DEVELOPMENT` run with `maxTurns: 80`
(`settings/store.ts:86`) reading and writing source files produces single-digit
megabytes of JSON; seven stages per task, more with rework, and a hundred tasks is
comfortably several gigabytes in a SQLite file both processes hold open in WAL mode
(`bootstrap.sql.ts:10`). Nothing deletes any of it except the `ON DELETE CASCADE`
from `stage_runs` (`schema.ts:159-161`), which fires only when the whole task is
deleted — and `deleteCreatedTask` (`orchestrator.ts:530-539`) refuses any task past
`CREATED`, so in practice it never fires at all.

```ts
// AppSettings, beside workspaceRetentionDays (settings/store.ts:43)
/** Days to keep full transcripts. `null` keeps them forever. */
transcriptRetentionDays: number | null;
```

Env default `TRANSCRIPT_RETENTION_DAYS`, resolved in `resolveLimits`
(`config/env.ts:145-154`) beside `workspaceRetentionDays`.

**The default is `null` — keep forever.** Deleting a user's audit trail by default,
in a tool whose README sells that trail as a reason to use it, is the wrong
default: `workspaceRetentionDays` defaults to 7 because a workspace is a
reproducible cache, and a transcript is not reproducible at all. `null` rather than
`0`, because `workspaceRetentionDays: 0` already means *delete immediately*
(`orchestrator.ts:130-134`) and giving `0` the opposite meaning one field away is
the kind of asymmetry that produces a data-loss bug. Settings shows
`SELECT count(*), sum(length(transcript_json)) FROM agent_runs`, turning an
abstract knob into a decision.

**The transcript body is replaced by a tombstone —
`{"pruned":true,"prunedAt":…,"originalBytes":…}` — and the row is not deleted.**
Deleting the row makes a pruned run indistinguishable from one that never had a
transcript: a Stakeholder stage, or a run that failed before the provider returned.
The tombstone lets the viewer say *"transcript pruned on 14 April"*, which is a
true statement about the record; `session_id` is kept. **The prompt columns from §4
are never pruned** — bounded at 400 KB, the smaller half, and the half that answers
the README's question. A write-time cap `MAX_TRANSCRIPT_BYTES = 8_000_000` applies
regardless of retention, dropping the middle and keeping head and tail, because the
setup and the outcome are the informative ends.

**The sweep is not a job.** `jobs.task_id` is `NOT NULL` (`schema.ts:244-245`) by
design, and a global maintenance sweep has no task to hang off; bending that means
a sentinel task id or a nullable foreign key, for a sweep with no per-task
scheduling requirement. It runs in the worker — once at startup, next to
`requeueOrphanedJobs` (`worker/index.ts:176-177`), then every six hours from the
main loop (`worker/index.ts:181-190`) — because the worker already owns
long-running maintenance and the web process must not do multi-megabyte `UPDATE`s
inside a request.

```sql
UPDATE agent_runs
   SET transcript_json = :tombstone
 WHERE created_at < :cutoff
   AND transcript_json NOT LIKE '{"pruned":true%';
```

`VACUUM` is not run automatically. It rewrites the whole file under an exclusive
lock, which is exactly what a two-process WAL setup must not do on a timer.
Settings offers it as an explicit button with a warning.

---

## 12. Latent bugs this feature would trip

### 12.1 `ArtifactTabs` ordering silently drops two artifact types

`ORDER` (`src/components/artifact-tabs.tsx:20-27`) lists six types; `ARTIFACT_TYPES`
(`stages.ts:126-136`) has eight. `code_review_report` and `human_review` are
missing, so `ORDER.indexOf` returns `-1` for both (line 31) and they sort **before**
`brief`; the panel then opens on `sorted.at(-1)` (line 58), which is no longer "the
newest stage in pipeline order". Adding `diff_summary` (§8) makes it three. The fix
is to type the ordering as `Record<ArtifactType, number>` so the compiler refuses a
new type with no position — the totality trick that already protects
`ARTIFACT_FILENAMES`, `STAGE_LABELS` and `GATE_ALLOWED_DECISIONS`.

Separately, the tab `value` is the artifact *type* (line 64) while the key is the
artifact *id* (line 63). With one row per type that is consistent; §7 introduces
several rows per type, at which point two triggers share a `value` — which is why
§7 keeps one tab per type and puts version selection inside the panel.

### 12.2 The transcript of a failed run is thrown away

`saveTranscript` is at `execute.ts:221`, *after* the catch block at
`execute.ts:215-219` that marks the run failed and rethrows. Every provider builds a
partial result specifically for this case: `StageExecutionError` carries
`partial: Partial<StageExecutionResult>` (`providers/types.ts:42-50`) and all three
populate it with the transcript so far (`claude.ts:124`, `142`; `openai.ts:111`,
`165`; `gemini.ts:116`, `171`).

**It is read by nobody.** The run whose transcript is most worth having — a
`max_turns` blowout, a session that ended `error_during_execution`, a tool loop —
is the only run guaranteed not to have one. The catch block persists
`error.partial.transcript` when the error is a `StageExecutionError`, with the
partial token counts. That also gives cost accounting a number for failed runs,
which today record `costUsd = 0` because `updateStageRun` (`execute.ts:229-233`) is
never reached.

### 12.3 OpenAI and Gemini transcripts contain no tool results

`openai.ts:100` pushes `response`; the conversation lives in `messages`
(`openai.ts:80-83`, `114`, `156`) and is discarded. `gemini.ts:104` pushes
`response`; the conversation lives in `contents` (`gemini.ts:86`, `119`, `163`) and
is discarded. A viewer built on this shows what the model said and nothing it was
told — no file contents, no command output, no denial. Claude's is complete because
`claude.ts:79` pushes every stream frame. One line per provider fixes it, at the
point the result is already being appended to the conversation array.

### 12.4 The credential denylist does not apply to `Read`

`checkBashCommand` is reached only for `toolName === "Bash"`
(`guardrails.ts:182-185`). `PATH_TOOLS` (`guardrails.ts:16`) — `Read`, `Edit`,
`Write`, `NotebookEdit`, `Glob`, `Grep` — are checked for workspace containment
only (`guardrails.ts:197-205`). So `Bash("cat .env")` is denied and
`Read({ file_path: ".env" })` is allowed. Both put the same bytes in front of the
model; only one is blocked. §10.1's first layer closes it.

### 12.5 A stage run can own more than one transcript row

`saveTranscript` inserts with a fresh `newId("agent")` on every call
(`service.ts:526-531`), and `agent_runs` has no unique index on `stage_run_id`
(`schema.ts:155-167`). The worker retries a failed job against the *same*
`stageRunId` up to `MAX_JOB_ATTEMPTS = 3` (`worker/index.ts:30`, `66-70`), so a
retryable failure raised **after** line 221 produces a second successful execution
and a second row. *Corrected:* `advanceTask` (`execute.ts:307`) is not the only
reachable case — the git calls at `execute.ts:273` and `283` and the plain
DB/event writes at `247`, `253` and `299` all throw raw errors, and
`handleJobFailure` treats anything that is not explicitly `retryable: false` as
retryable (`worker/index.ts:86-94`). The
viewer must therefore read *rows*, ordered by `created_at`, and show the newest,
rather than assuming a single `.get()`. A unique index would be tidier but would
then need conflict handling on a path that currently cannot fail.

---

## 13. Test plan

**Normaliser (pure, no DB)**
- Claude fixture: `init` → `meta`, text block → `text`, `tool_use` → `tool_use`
  with the full input, a `user` frame's `tool_result` → `tool_result`, `result` →
  `result` with usage. OpenAI fixture: content → `text`, `tool_calls[]` →
  `tool_use` with parsed arguments, malformed `arguments` JSON yielding the raw
  string and no crash. Gemini fixture: `parts[].text` and `functionCall`.
- An unrecognised element becomes `unrecognised: true` with the raw JSON preserved.
- A `NULL` provider falls back to sniffing and reports `"unknown"`, not empty.

**Redaction and guardrails (pure)**
- Parameterised over `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `sk-`, `AKIA…`,
  `API_KEY=…`, `"password": "…"` and a PEM block: the key name survives, the value
  does not. `redactRemote`'s two existing shapes still redact after the extension.
- **The negative case is asserted deliberately:** a 40-character base64 blob under
  the key `clientAuth` is *not* redacted, encoding §10.3's limit so a later reader
  does not mistake the redactor for a guarantee.
- `Read`, `Glob` and `Grep` against `.env`, `.env.production`, `id_rsa`,
  `.ssh/config` and `.npmrc` are denied, over both the Claude guard and the
  `tool-runtime` path that shares it (`tool-runtime.ts:364`) — while
  `src/server/config/env.ts` is still allowed. *Corrected:* the allowed-path
  example was `src/lib/env.ts`, which does not exist; and the `Glob`/`Grep` half
  only passes once §10.1 extends `pathsInInput` to `pattern` and `glob`, since
  those calls carry no key it currently reads.

**Artifacts**
- `diff_summary` validates its two sections; one missing `## Files` fails.
- `listArtifacts(taskId, "dev_report")` returns three rework versions newest-first;
  `listArtifactVersions` returns the same three with attempts and no bodies.
- Adding an `ArtifactType` without a position in `ArtifactTabs`' ordering fails to
  compile (§12.1). This one is enforced by `npm run typecheck` (`tsc --noEmit`),
  not by `vitest run`: `vitest.config.mts` does not enable Vitest's typecheck mode,
  so a `*.test-d.ts` file would be silently ignored.

**API**
- `?offset`/`?limit` slice the entries; `total` is the unpaginated count.
- A `runId` from a different task → 404, parameterised over a valid foreign id and
  an unknown one.
- A pruned transcript returns `available: false` with `prunedAt`, distinct from a
  run that never had one.
- Export includes every artifact version, excludes attachment bytes and
  `credentialRef`/`credentialUsername`/`apiBaseUrl`; `?transcripts=0` omits entries
  and keeps prompts.

**Integration**
- A full run leaves, per **agent** stage run, a non-null `system_prompt`,
  `user_prompt`, `model` and `provider`, plus one `agent_runs` row. *Corrected:*
  "per stage run" would fail on the `DELIVERY` run — `executeDelivery` never calls
  `runStage`, so its row keeps all four columns `NULL` and owns no transcript. The
  assertion is scoped to `isAgentStage(run.stage)`, and the `DELIVERY` run is
  asserted to be the null case, which is also what §11's tombstone has to stay
  distinguishable from.
- A stage whose provider throws leaves a `failed` run **with** a partial transcript
  and non-zero token counts (§12.2).
- `DELIVERY` writes `diff_summary` before the push; a delivery whose push fails
  still has the artifact.
- The sweep tombstones a transcript past the cutoff, leaves the prompt columns
  intact, and is idempotent when run twice.

**Component**
- The transcript renderer contains no `dangerouslySetInnerHTML` and no `innerHTML`
  — the assertion `tests/diff-viewer-safety.test.ts` makes for the diff viewer.
- The version switcher opens on the newest version, badges an older one, and is
  absent for a type with one version; the comparison renders through `PatchBody`
  and marks added and removed lines with gutter characters, not colour alone.

---

## 14. Phasing

**Phase A — record what cannot be recovered later.** The four `stage_runs` columns
and their migration (§4), the transcript on failure (§12.2), the tool results in
the OpenAI and Gemini transcripts (§12.3), the write-time byte cap (§11), and both
redaction layers plus the guardrail fix (§10.1). No UI at all. Independently
valuable, and first for a reason no other ordering has: this is the only phase
whose data cannot be backfilled. Every day the pipeline runs without it is a day of
runs whose prompt is gone permanently.

**Phase B — read it back.** The normaliser (§5), the transcript API and the run
page (§6), artifact version history and the comparison (§7), and the `diff_summary`
artifact with its post-cleanup rendering (§8). Independently valuable: this is the
screen `README.md:51-53` already promises, and it is useful against Phase A's data
on the first task that runs after it lands.

**Phase C — export and retention.** The export route (§9) is one handler over the
queries Phase B already wrote; retention (§11) is the sweep, the setting and the
size readout. Last, because it is the phase a user only wants once they have
accumulated enough record to move or to prune — a consequence of A and B working.

---

## 15. Open questions

1. **Should the normalised transcript be persisted rather than computed?** Computed
   here (§6.1), on the strength of the 8 MB cap and an immutable-row memo.
   Persisting it makes pagination a real SQL `LIMIT`, at the cost of a second copy
   of the largest table in the database and a backfill for every existing row. The
   deciding measurement is the parse time of a real `DEVELOPMENT` transcript —
   which nobody has taken, because nothing has ever read one.
2. **Per-turn cost attribution.** OpenAI reports `usage` on every call
   (`openai.ts:102-103`) and Gemini on every `generateContent`
   (`gemini.ts:106-107`), so per-turn cost is derivable for two providers. Claude's
   SDK reports totals only, at the `result` frame (`claude.ts:105-107`). A per-turn
   column would be populated for two of three providers and null for the third — a
   table with a hole, usually worse than no table.
3. **Redacting artifact bodies.** Out of scope per §2, because artifacts are the
   deliverable. But an artifact is also the thing most likely to be pasted into a
   chat or a ticket, and a `dev_report` quoting a config file is not hypothetical.
   Redacting it would make the artifact shown in the UI differ from the artifact
   the next agent consumed, which is a worse property than the exposure.
4. **Full-text search across transcripts.** SQLite FTS5 is available and the data
   is already there. Deferred because the demonstrated need is "what happened in
   this run" — but the moment a user has fifty tasks the second question is the one
   they will ask, and retrofitting FTS over tombstoned rows means accepting a
   permanently incomplete index.
5. **A live transcript for a running stage.** Deferred because the array only
   reaches the database when the run ends. The alternative is streaming entries as
   events, making the live log and the transcript one surface at one fidelity —
   attractive, but it multiplies the `events` table's write volume by roughly the
   number of tool calls per run, and `appendEvent` takes a transaction and a
   `max(seq)` read per write (`events/store.ts:50-74`).
6. **Should a completed task become deletable?** `deleteCreatedTask`
   (`orchestrator.ts:530-539`) refuses anything past `CREATED` because a started
   task owns a workspace (`spec-task-queue.md` §7.2). After §11 that argument is
   weaker — cleanup already removed the workspace — and the cascade would take the
   whole record with it (`schema.ts:83-85`, `159-161`). Allowing it makes "delete
   this task's record" one click, which is either a feature or a data-loss footgun
   depending on what the trail is worth.
