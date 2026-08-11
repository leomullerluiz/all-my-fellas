# HTTP API

Everything the dashboard does, it does through these routes. They are also what
a CI job, a script or a phone would use.

Base URL is wherever the Next.js process is listening — `http://localhost:3000`
by default. All bodies and responses are JSON unless noted.

## Authentication

Open by default. Once a token exists, **every** `/api/*` request needs one:

```
Authorization: Bearer <secret>
```

Anything else gets `401`. Mint a token with `npm run token:create -- --name=CI`;
see [`operations.md`](operations.md#api-tokens). A token is a label, not an
identity — it grants everything, and its name is recorded as the actor on the
actions that record one (gate decisions, most usefully).

## Conventions

| Status | Meaning here |
|---|---|
| `400` | the body failed validation — the response carries the field issues |
| `404` | no such task, repository, run or artifact |
| `409` | a legitimate refusal, not a fault: no capacity, quota held, wrong stage, nothing retryable, an unfinished prerequisite |
| `503` | `/api/health` only — the worker is stale or was never started |

`409` is used liberally on purpose: a board a few seconds stale, a second tab, or
a prerequisite that just failed all make these ordinary outcomes rather than
server errors.

---

## Tasks

### `POST /api/tasks`

Creates a task. Accepts JSON, or `multipart/form-data` when it carries
attachments.

| Field | |
|---|---|
| `repoId` | required |
| `title` | required, 3–160 chars |
| `description` | required, 20–50 000 chars |
| `priority` | `low` · `medium` *(default)* · `high` · `urgent` |
| `requireHumanCodeReview` | default `false` — park at the diff-review gate before delivery |
| `branchName` | optional; overrides the generated `pipeline/{taskId}-{slug}`, checked against git's ref rules |
| `dependsOn` | up to 50 task ids that must reach `COMPLETED` first |
| `maxCostPerTaskUsd` | optional spend ceiling for the whole task |
| `duplicateFrom` | optional task id whose attachments are copied onto the new one |
| `start` | default `false` — a task left sitting costs nothing, a task started by accident costs quota and a clone |

### `GET /api/tasks`

Query: `status`, `repo`, `priority`, `q` (free text over title and
description), `archived=1` to include archived tasks. An unknown `status` or
`priority` is a `400` — this is an API contract, unlike the board's own lenient
URL parsing.

Returns the tasks, current capacity, and each task's execution state.

### `GET /api/tasks/:id`

Stage, status, every stage run, the latest artifacts, approvals, dependencies,
attachments, total cost, execution state, and retryability.

### `PATCH` / `DELETE /api/tasks/:id`

Both only while the task is still at `CREATED`; `409` otherwise. `PATCH` takes
the same fields as creation, minus `start`, `branchName` and `duplicateFrom`.

### Lifecycle

| Route | Notes |
|---|---|
| `POST /api/tasks/:id/start` | Admission + dependency + quota controlled. Optional body `{"overrideQuota": true}` for the "Start anyway" affordance on a quota-held task. `409` with code `quota_exceeded`, or for no capacity / an unfinished prerequisite |
| `POST /api/tasks/:id/cancel` | Aborts the running session and drops pending jobs. No-op on an already-terminal task |
| `POST /api/tasks/:id/pause` · `/resume` | Finish the current stage, then withhold the next; then continue. Pause applies to `running` and `awaiting_gate` tasks |
| `POST /api/tasks/:id/retry` | Re-runs the stage the recorded failure cause implies. `409` when nothing is retryable, when no cause was recorded, or when the branch history a retry needs is gone |
| `POST /api/tasks/:id/deliver-retry` | Re-runs only the change-request call against the already-pushed branch. `409` when the task's delivery was not a `manual` outcome |
| `POST /api/tasks/:id/run-next` | Bumps a queued task to the front. A no-op, not an error, if it is no longer queued |
| `POST /api/tasks/:id/reopen` | Moves a terminal-but-undelivered task back to `CREATED`, keeping its artifacts |
| `POST /api/tasks/:id/archive` · `/unarchive` | Soft-delete and restore. Safe in any state; only visibility changes |

### Gates

```
POST /api/tasks/:id/gates/PLAN_GATE
POST /api/tasks/:id/gates/HUMAN_CODE_REVIEW
POST /api/tasks/:id/gates/STAKEHOLDER_GATE
```

```json
{ "decision": "approve" | "request_changes" | "reject", "comment": "…" }
```

`request_changes` **requires** a comment — without one the Developer (or the
Architect, from the plan gate) has nothing to act on and a full rework cycle is
spent re-submitting the same code. Comments are capped at 4 000 characters and
persisted as `human-review.md` so they reach the next prompt.

The response says whether execution resumed immediately or was queued for
capacity.

### Batch

```
POST /api/tasks/batch-start
POST /api/tasks/batch-archive
POST /api/tasks/batch-cancel
```

Body `{"taskIds": ["…"]}`. Always `200` with a per-task result: one task's
failure does not stop the rest. `batch-start` admits in priority/difficulty
order.

### Reading the work

| Route | Returns |
|---|---|
| `GET /api/tasks/:id/stream` | **SSE**, this task's events, resumable with `Last-Event-ID` |
| `GET /api/tasks/:id/diff` | The changed-file index. `?file=<path>` returns that file's unified patch. When the workspace is gone, returns `available: false` plus the persisted diff summary |
| `GET /api/tasks/:id/runs/:runId/transcript` | One run's normalized transcript. Paginated — default 50 entries, max 500. Reports a tombstone when retention pruned it |
| `GET /api/tasks/:id/artifacts/:artifactId` | One artifact version's Markdown |
| `GET` / `DELETE /api/tasks/:id/attachments/:attachmentId` | Download, or remove |
| `GET /api/tasks/:id/workspace/status` | Uncommitted changes in the workspace |
| `POST /api/tasks/:id/workspace/commit` | Commits them. Only at `HUMAN_CODE_REVIEW` — at any other stage a running job owns that working tree |
| `GET /api/tasks/:id/export` | The whole record as one JSON file. `?transcripts=0` for the small version |

### `GET /api/events/stream`

**SSE** across every task, cursored on the global event id. This is what tells
the board about a gate opening on a task you are not looking at.

---

## Repositories

### `GET /api/repos` · `POST /api/repos`

`POST` registers a connection:

| Field | |
|---|---|
| `name` | required |
| `url` | required, `http(s)://` with a host. Git's remote-helper syntax (`ext::sh -c …`) is rejected here, and again in the provider layer |
| `provider` | omit to auto-detect from the host; required for a self-managed instance |
| `defaultBranch` | default `main` |
| `credentialRef` | the **name** of an environment variable, never a value. Reserved names are rejected. Required for `generic` |
| `credentialUsername` | overrides the provider's Basic-auth username |
| `apiBaseUrl` | for a self-managed GitLab |
| `context` | free-text project documentation, handed to every stage prompt |

The response carries a live access check, the repository's real default branch,
and `suggestedCommands` — verification commands detected from a throwaway clone.
Suggestions are never saved by this route; storing one is always a `PATCH`.

### `GET` / `PATCH` / `DELETE /api/repos/:id`

`GET` re-checks access live. `PATCH` writes **only** the five verification
fields — `verifyInstall`, `verifyBuild`, `verifyTest`, `verifyLint`,
`verifyTimeoutSeconds` (30–3600) — and is strict: any other key is a `400`
rather than a silent partial update. Each command is a single argv, spawned with
no shell; shell metacharacters are rejected with an explanation rather than
being sanitised. `DELETE` refuses while tasks still reference the connection.

---

## Settings

### `GET` / `PATCH /api/settings`

Partial patches. Record-shaped fields (`models`, `providers`, `maxTurns`,
`quotaLimits`, `notifications.events`) merge per key, so one role's model can be
changed without resending the map.

| Field | Range |
|---|---|
| `models` | per stage: `{"tier": "light" \| "default" \| "heavy"}` or `{"literal": "<model id>"}` |
| `providers` | per stage: `claude` · `chatgpt` · `gemini` |
| `maxTurns` | per stage, 1–500 |
| `maxParallelTasks` | 1–8 |
| `reworkMaxCycles` | 0–10 |
| `autoApprovePlanForLowCriticality` · `noApprovalAutomation` · `humanCodeReviewDefault` · `queueHeld` | boolean |
| `codeReviewEnabled` | `always` · `auto` · `never` |
| `quotaLimits` | per pool `subscription` / `api_key` / `chatgpt` / `gemini`: `{limitUsd, cadence}`, `limitUsd: null` clears it |
| `quotaEnforcement` | `off` · `warn` · `hold` |
| `warningRatio` | 0–1 |
| `maxCostPerStageUsd` | number or `null` |
| `workspaceRetentionDays` | 0–365 |
| `transcriptRetentionDays` | 0–3650, or `null` to keep forever |
| `theme` | `dark` · `light` · `system` |
| `notifications` | `{browser, webhookUrl, webhookSecretRef, events}` — the secret ref is an environment variable **name** |

### `POST /api/settings/test-provider`

`{"provider": "claude" | "chatgpt" | "gemini"}` — sends the literal message
`test` outside the pipeline entirely and returns the reply. `400` with a
readable reason for a missing credential, a provider error, or a timeout.

### `POST /api/settings/vacuum`

Runs `VACUUM`. Explicit and manual; never on a timer.

---

## Usage and health

| Route | |
|---|---|
| `GET /api/usage?days=&taskId=` | Token and cost aggregates. `days` 1–365, omitted means all time |
| `GET /api/usage/export?days=&taskId=` | CSV, one row per stage run — including failed and cancelled ones |
| `GET /api/health` | Worker liveness: `never_started` · `healthy` · `lagging` · `stale`, with heartbeat age and the active task. `200` for healthy/lagging, `503` otherwise |
