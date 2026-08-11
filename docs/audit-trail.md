# The audit trail

A pipeline that spends your money on seven sessions owes you an answer to *"why
was it built this way"*, not just *"what changed"*. Everything below is written
as a side effect of running, and all of it is readable from the dashboard.

None of it is ever fed back into a later stage. The minimum-context handoff is
the point: transcripts are for humans.

---

## What is recorded

### Per stage run

Every attempt at every stage — including failed and cancelled ones — keeps:

| | |
|---|---|
| **The prompt** | the exact system prompt and user prompt that were sent, written *before* the provider is invoked, so a run that crashed still has one |
| **Who answered** | the provider and the resolved model id, stored at run time — switching a role's provider later cannot retroactively change what a past run says it used |
| **What it cost** | input, output, cache-read and cache-write tokens, and dollars. Partial cost is recorded on failure rather than zero |
| **How it ended** | `pending` · `running` · `done` · `failed` · `rejected` · `cancelled`, with the error text, plus turn ceiling and timing |
| **The rejected output** | when an artifact failed validation, the text that failed it — even when the repair attempt also failed, so a paid-for session's output is never simply discarded |
| **The reviewed SHA** | for `CODE_REVIEW` and `QA`, the commit that was reviewed — which is what lets the next rework cycle show that reviewer only what changed since |

### The transcript

The full conversation, per run, for all three providers. Read it at
**`/tasks/{id}/runs/{runId}`**: prompts collapsed at the top, then the paginated
transcript — assistant text, thinking, every tool call with its **full input**
and result, denials with the real reason, and the terminating result message.

Storage stays provider-specific; the normalization into one shape happens on
read, so nothing was lost at write time to make the viewer simpler.

### Artifacts

Every version, not just the newest. Attempt 1's plan can be read against attempt
3's. Each version is owned by the stage run that produced it.

Two of them are written by the worker rather than an agent:

- `verification-report.md` — the mechanical results.
- `diff-summary.md` — a per-file status table written at `DELIVERY`, so the shape
  of the change outlives the workspace. When the clone is gone, the diff screen
  falls back to this instead of showing nothing.

### Everything else

- **Events** — an append-only log per task, the same rows both SSE streams tail.
- **Approvals** — every gate decision with its comment, and the actor that made
  it (an API token's name, when a token made the call).
- **Verification runs** — one row per command: the command as configured, exit
  code, timeout flag, duration, and the tail of each stream.
- **Attachments** — stored as blobs on the task, not on disk, because a task has
  attachments before it has a workspace and after the workspace is deleted.

---

## Secret redaction

Prompts and transcripts are scrubbed on the way in and again on the way out, by
six pattern rules: remote-URL credentials, Basic-auth headers, PEM blocks,
`"name": "value"` JSON pairs for credential-shaped names, `NAME=value`
assignments, and known token prefixes. The pass is idempotent, so redacting an
already-redacted string cannot corrupt it.

This is defence in depth, not a guarantee. A high-entropy value under a name the
rules do not recognise, or a credential written out in prose, is not caught. The
honest claim is that the shapes we know about are masked.

Separately, the guardrail layer denies agents reading credential-bearing paths at
all, so the common case never reaches a transcript to be redacted.

---

## Exporting a task

```
GET /api/tasks/:id/export            # everything
GET /api/tasks/:id/export?transcripts=0   # metadata only, much smaller
```

One JSON object — format `all-my-fellas/task-record`, version 1 — carrying the
task, its repository, every stage run with its prompts and normalized
transcript, every artifact version, approvals, attachments (metadata), events,
and dependencies. The payload also reports how many redaction patterns ran and
how many hits they scored, so a reader can tell what was checked.

A single object rather than a zip of Markdown files: the value here is
relational — which run produced which artifact, at which attempt, under which
prompt, at what cost — and filenames would flatten that.

There is no import counterpart. This is a record, not a backup; for backups see
[`operations.md`](operations.md).

---

## Retention

Transcripts are kept forever by default. Set `transcriptRetentionDays` (or
`TRANSCRIPT_RETENTION_DAYS`) and the worker prunes older ones at startup and
every six hours.

A pruned transcript is replaced by a **tombstone**, not deleted outright, so the
viewer and the export say *"removed on the 3rd"* rather than showing an empty
run. Everything else about the run — prompt, model, tokens, cost, status,
artifacts — survives.

The workspace has the opposite default (7 days) on purpose: a clone is a
reproducible cache, a transcript is not reproducible at all.

Pruning rows does not shrink the database file. Settings → **Reclaim space** runs
`VACUUM` when you ask for it.
