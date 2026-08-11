# Operations

The product's thesis is *write the task, walk away, trust what comes back*. That
only holds if walking away is safe. This page is everything that makes it safe:
what stops spend, what stops work, how you know the worker is alive, how you get
told when something needs you, and what to do about backups and retention.

Everything here is either a Settings field or a `.env` default the Settings
screen overrides. The worker re-reads settings at the start of every job, so a
change takes effect on the next stage — no restart.

---

## Spend

### Quota, as an admission decision

There is no API that reports your real Pro/Max allowance or your current
Anthropic bill, so a quota here is always a number you typed. What changes is
what the number *does*.

Limits are configured per pool, each with its own cadence — `daily`, `hourly` or
`monthly`, measured from local midnight / the local top of the hour / the first
of the local month:

| Pool | Covers |
|---|---|
| `subscription` | Claude via `CLAUDE_CODE_OAUTH_TOKEN` |
| `api_key` | Claude via `ANTHROPIC_API_KEY` |
| `chatgpt` | every role running on OpenAI |
| `gemini` | every role running on Google |

Claude keeps the subscription/API-key split because that distinction is real for
Claude and meaningless for the other two, which only ever bill per token.

**Enforcement** is a separate setting from the limit:

| Mode | Behaviour on Start |
|---|---|
| `off` *(default)* | the usage bar renders; nothing is refused. An existing install behaves exactly as it did before this existed |
| `warn` | the start proceeds and a `quota_warning` event is recorded — which is also a notifiable event |
| `hold` | the start is refused with a `quota_exceeded` conflict. The UI offers **Start anyway**, which sends `{"overrideQuota": true}` and records a `quota_overridden` event |

The **warning threshold** (default 80%) decides when the bar turns amber and when
the quota warning appears beside every Start affordance, not just on the
dashboard.

### Ceilings that actually stop a run

- **Per stage** (Settings → *Max cost per stage*): passed into every provider and
  checked while the session runs. Claude enforces it through the Agent SDK's own
  `maxBudgetUsd`; the ChatGPT and Gemini loops check between turns. It is a
  stop-loss, not a hard cap — the check happens after the turn that crosses the
  line.
- **Per task** (on the task, set at creation or while editing): checked before
  each stage is scheduled. Once a task's accumulated spend reaches its ceiling,
  the next stage is not enqueued.

### Where the money went

`/usage` breaks spend down by task and by stage, with a daily chart. **Export
CSV** gives one row per stage run — including failed and cancelled runs, which
partial-cost recording keeps honest rather than reporting `$0` — at the grain you
need to reconcile against an invoice.

Claude's dollar figure comes from the Agent SDK's own `total_cost_usd`; on a
subscription that is an estimate of equivalent API spend, not a bill. ChatGPT and
Gemini report only tokens, so their dollars are computed locally from a static
price table and will drift as providers reprice.

---

## Stopping and starting work

| Control | Effect | Scope |
|---|---|---|
| **Cancel** | aborts the session in flight — the abort controller is real, not just a row update — and drops the task's pending jobs | one task |
| **Pause** | lets the current stage finish, then stops scheduling the next one. **Resume** picks up where it stopped | one task |
| **Hold the queue** (Settings) | the worker claims no new jobs. Whatever is already running is untouched | the whole install |
| **Archive** | hides a terminal task from the board, the list and the dependency picker. Every row and every `/usage` total survives | one task, or a batch |

### Admission and queue order

At most `maxParallelTasks` tasks are admitted at once, checked when you press
Start rather than deep inside the worker. Over that limit, a started task waits
in **On queue** with its status recorded as such.

The queue is ordered **priority descending, difficulty ascending** — urgent
before high before medium before low, and within a priority, `S` before `M`
before `L`. A task the Architect has not estimated yet sorts as `M` rather than
last, so un-estimated work is not starved. **Run this next** on a queued card's
menu bumps one task to the front without changing anything else.

A task can also declare that it depends on other tasks; Start refuses while a
prerequisite is unfinished.

### Knowing what is actually running

The worker runs one job at a time. Above `maxParallelTasks = 1`, most admitted
tasks are waiting rather than running, and the board says which:

| State | Meaning |
|---|---|
| in flight | the worker has this task's job claimed — an agent session, a delivery, or verification |
| waiting for worker | admitted, job enqueued, position in the queue shown |
| retry backoff | a retryable failure put the job back with a future start time |
| settling | admitted with neither a claimed nor an eligible job — the brief window between stages, or a genuinely stranded task |
| idle | not admitted: created, queued, at a gate, or terminal |

---

## Worker liveness

The worker has no HTTP server of its own, so it writes a heartbeat row and the
web process reports on it.

| State | Heartbeat age |
|---|---|
| `healthy` | ≤ 3 seconds |
| `lagging` | ≤ 60 seconds |
| `stale` | older, or the process is gone |
| `never_started` | no heartbeat has ever been written |

The nav shows this continuously. `GET /api/health` returns 200 for `healthy` and
`lagging`, and **503** for anything else — which is what `docker-compose.yml`'s
worker healthcheck hits, so a dead worker fails the container check rather than
passing it with a note.

A `stale` worker that was holding a task is reported as **interrupted**: it died
mid-stage, and that task will sit at `running` until the worker restarts and
returns its claimed job to `pending` — which happens automatically on the next
start.

---

## Notifications

Two independent channels, both configured in Settings, both per event type.
Enabled by default: `gate_opened`, `task_finished`, `pr_opened`, `quota_warning`
— the moments where a human is either blocked or has to decide. Notifying on
everything trains you to ignore it.

**Desktop notifications.** Off until you grant browser permission through the
explicit consent control in Settings; the dashboard listens on the global event
stream, so a gate opening on a task you are not looking at still reaches you.

**Webhook.** One `POST` per enabled event to a URL of your choosing — Slack,
Discord, ntfy, n8n, Zapier, your own script — with a flat JSON body:

```json
{
  "event": "gate_opened",
  "taskId": "task_...",
  "taskTitle": "Add rate limiting to the public API",
  "repo": "acme/platform",
  "stage": "PLAN_GATE",
  "url": "http://localhost:3000/tasks/task_...",
  "at": 1754820000000
}
```

`url` is built from `APP_URL`, because a notification fired from the worker has
no request to derive an origin from. Set that if the dashboard is not on
`http://localhost:3000`.

To sign the payload, name an environment variable in the *webhook secret*
field — the value never enters the database, following the same rule as every
other credential here. When set, requests carry
`X-Signature: sha256=<hmac-sha256 of the raw body>`.

Delivery is fire-and-forget: 5-second timeout, up to three attempts with
backoff, and a failure is logged and swallowed. A broken webhook must never fail
or block the pipeline.

---

## API tokens

`/api/*` is open by default — a local-first tool binding to localhost should not
require setup to work. Create a token and it stops being open, for every request,
immediately:

```bash
npm run token:create -- --name=CI
# or, with the secret already in an environment variable:
npm run token:create -- --name=CI --secret-env=CI_API_TOKEN_SECRET
```

Without `--secret-env` the script generates a secret and prints it **once** — the
database stores only a scrypt hash, and there is no recovery path. Requests then
need `Authorization: Bearer <secret>`.

A token is a **label, not an identity**: there are no permissions, no scopes and
no per-token restrictions. What its name buys you is attribution — an action
taken with a token is recorded against that name in the event log, so "who
approved this gate" has an answer when a CI job did it.

This gates the API only. The dashboard itself still has no authentication; do not
expose the port publicly.

---

## Backup, retention and disk

### Backup

```bash
npm run db:backup     # → data/backups/pipeline-<timestamp>.db
```

Uses SQLite's online backup API rather than a file copy, so it is safe to run
while the worker is writing. Each run writes a new timestamped file.

**There is deliberately no restore button.** Restoring is an offline file copy:
stop both processes, replace the database file (and remove any `-wal`/`-shm`
siblings), start them again. A one-click restore over a live WAL database with
two writers is a way to lose data, not to recover it.

### Retention

| What | Setting | Default |
|---|---|---|
| Task workspaces (clones) | `workspaceRetentionDays` / `WORKSPACE_RETENTION_DAYS` | 7 days |
| Full transcripts | `transcriptRetentionDays` / `TRANSCRIPT_RETENTION_DAYS` | unset — kept forever |

The defaults are opposite on purpose: a workspace is a reproducible cache, a
transcript is not reproducible at all. A pruned transcript leaves a tombstone
recording when it was pruned, so the viewer and the export can say *"this was
removed on the 3rd"* rather than showing an empty run. The sweep runs in the
worker at startup and every six hours.

Deleting rows does not shrink the file. Settings → **Reclaim space** (or
`POST /api/settings/vacuum`) runs `VACUUM` explicitly. It is never on a timer:
`VACUUM` takes a write lock over the whole database, which is not something to do
behind the user's back while a stage is running.
