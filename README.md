# Multi-Agent Delivery Pipeline - All My Fellas

A local application that runs a software delivery pipeline staffed by LLM
agents. You describe a feature; the task walks a pipeline that simulates a
full team — **Stakeholder → Product Owner → Architect → Developer →
Verification → Code Review → QA → Homologation** — and the result arrives as a
branch and an open pull request (a *merge request*, on GitLab) against a real
repository: GitHub, GitLab, Bitbucket, Azure DevOps, or any plain git server.

Each role can run against **Claude** (Anthropic), **ChatGPT** (OpenAI), or
**Gemini** (Google) — picked per role from Settings. Claude is the default for
every role and needs no configuration change; see
[`docs/llm-providers.md`](docs/llm-providers.md) for how to set up each one.

Built with Next.js (UI + API), a separate Node worker process, SQLite, and the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), [OpenAI
SDK](https://github.com/openai/openai-node), and [Google Gen AI
SDK](https://github.com/googleapis/js-genai).

---

## Why All My Fellas

**Writing the spec is the expensive part.** Handing a feature to one agent means
authoring the plan yourself first — the context, the constraints, the acceptance
criteria, the order of the changes — and authoring it again when the first
attempt comes back wrong. Here you write a title and a description, pick the
repository, and the brief, the user stories and the technical plan are produced
for you. Your job is to read the plan and say yes, no, or *redo this part*.
Reading a plan is cheaper than writing one, and far cheaper than finding out the
approach was wrong on a finished branch.

**A reviewer that shares your context is not a reviewer.** Ask one session to
write the code and then check it, and the check is performed by the thing that
already talked itself into the code — it re-reads its intentions rather than its
output. The Code Reviewer and QA are separate sessions that never see the
Developer's transcript. What they get is the acceptance criteria, the
Developer's written report, the branch diff and the pipeline's own mechanical
test results, and the verdict fails closed: a report that cannot be parsed as an
approval counts as changes requested. The independence is in the context, not
the model — development and code review default to the same tier.

**Nothing claims a check it did not run.** Install, build, test and lint are run
by the worker between Development and Code Review, against the commands
configured on the repository, and the pipeline routes on the real exit codes. A
red suite goes back to the Developer without paying for a reviewer or a QA
session. QA receives those results as an input; it never says it ran them.

**Your attention goes to decisions, not turns.** Two of them by default, the
technical plan and delivery, plus a diff review if the task opted into one. Each
is a document you read on your own schedule rather than a session you supervise
turn by turn, and the work carries on while you are doing something else — with
a desktop notification or a webhook when a gate opens, if you want one.

**A wrong turn costs one stage, not the run.** Every agent stage leaves a
validated artifact, so a retry re-runs that stage as a new attempt recorded
beside the failure — the brief, stories and plan you already paid for survive,
and so do the clone and the branch. The task records *why* it failed, so a retry
knows what to re-run instead of guessing.

**The trail is readable.** Every stage run keeps the exact prompt it was sent,
the model and provider that answered, the full transcript with secrets redacted,
and every version of every artifact. `/usage` says which stage spent your money;
a one-file JSON export says what happened, after the workspace is gone.

A one-line fix is faster by hand than seven agent stages and two gates. This
earns its cost on work you would have written a plan for anyway.

---

## What makes it different

**It reads the real code.** The Architect explores the repository before
choosing an approach, so its difficulty and criticality estimates come from what
is actually there rather than from the prompt alone.

**Minimum-context handoff.** Each stage is a brand-new session with no `resume`.
A stage's prompt is assembled from a fixed, auditable list: the role's system
prompt, the task metadata, the specific Markdown artifacts the previous stages
produced, and a small set of declared supplements — the branch diff for
reviewers, the mechanical verification result, the task's attachments, and the
repository's own `AGENTS.md`/`CLAUDE.md` conventions. No agent ever sees another
agent's transcript. Full transcripts are kept for auditing and are never fed
back into the pipeline.

**Nothing starts on its own.** A new task sits in the **Created** column until
you start it, and at most `maxParallelTasks` tasks are ever admitted — the limit
is enforced when you press Start, not deep inside the worker. The board
distinguishes *admitted* from *in flight*: only the task whose job the worker has
actually claimed says an agent is running, the rest say what they are waiting
for.

**Human gates where they matter.** The technical plan and the final delivery both
require a human decision, and a task can opt into a third between them: a human
code review of the diff. At every one of them you can also ask for changes rather
than only approve or destroy the task.

**Least privilege per role.** Only the Developer can write files. The Architect
and QA get Bash restricted to an inspection allowlist. The Stakeholder gets no
filesystem at all. Every tool call — including the Developer's edits — passes
through a `canUseTool` guard that confines paths to the task workspace and
blocks destructive or credential-touching commands, on every provider.

**The agents never hold credentials.** Cloning, pushing and opening the change
request are done by the worker. The token is injected into a remote URL — or an
`Authorization` header, for Azure DevOps — for the length of a single command,
and is never written to `.git/config`, the database, or an agent's environment.
What the database stores is the *name* of an environment variable, never its
value. Anything that looks like a secret is redacted before it reaches a log
line, a transcript or the browser.

**Spending has a valve, not just a gauge.** A configured quota can refuse a
start rather than merely colour a bar red; a task can carry a dollar ceiling that
stops it; Cancel aborts the session in flight instead of only marking rows.

**Any git host.** GitHub, GitLab, Bitbucket and Azure DevOps each get a real API
integration, so the pipeline opens the change request itself and calls it by the
name that host uses. Anything else — a self-hosted Gitea, an internal server —
works as a generic connection: the branch is pushed and you open the request by
hand.

---

## Requirements

- Node.js ≥ 20.9
- `git` on `PATH`
- A Claude credential (see below) — the default provider, no other LLM
  credential is required
- A token for whichever git host you use (see below)

No provider CLI is needed. `gh`, `glab` and `az` used to be optional
dependencies; the pipeline now calls each provider's REST API directly.

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
```

### Claude credentials

**Subscription (default).** Consumption comes out of your Claude Pro/Max plan.

```bash
npm i -g @anthropic-ai/claude-code
claude setup-token        # authenticate in the browser
# paste the token into .env as CLAUDE_CODE_OAUTH_TOKEN
```

**API key (alternative).** Set `ANTHROPIC_API_KEY` instead. No code changes —
the Agent SDK picks up whichever is present, and Settings shows the active mode.

> Anthropic's policy on programmatic use of a subscription has changed more than
> once. Check the current terms before relying on subscription mode for
> sustained runs; switching to an API key is an environment-variable change.
> This design assumes personal use with your own subscription — offering
> "log in with Claude" to other people requires approval from Anthropic.

### ChatGPT and Gemini credentials (optional)

Claude is the default provider for every role; nothing below is required for
an existing or a fresh install to keep working. Set these only if you want to
switch a role to ChatGPT or Gemini from Settings.

| Provider | Variable | Where to get it |
|---|---|---|
| ChatGPT (OpenAI) | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Gemini (Google) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

Each provider has a **Test connection** button in Settings that sends one
message outside the pipeline and shows the reply. Full setup steps, how the
model tier picker resolves per provider, and the known behavior differences
(cost reporting, tool-execution maturity, event granularity) are in
[`docs/llm-providers.md`](docs/llm-providers.md).

### Repository credentials

Put a token in `.env` for the host you use. It stays in the worker's
environment: it is never stored in the database and never reaches an agent.

| Host | Variable | Token scopes | Basic-auth username |
|---|---|---|---|
| GitHub | `GITHUB_TOKEN` | `repo` | `x-access-token` |
| GitLab | `GITLAB_TOKEN` | `api`, `write_repository` | `oauth2` |
| Bitbucket Cloud | `BITBUCKET_TOKEN` | `repository:write`, `pullrequest:write` | `x-token-auth` |
| Azure DevOps | `AZURE_DEVOPS_TOKEN` | Code (read & write), Pull Request Contribute | *(empty — sent as a header)* |
| Generic git server | *(you name it)* | whatever the server needs | `git` |

The username column is handled for you and is only worth knowing about when it
has to change. Bitbucket resolves an access token **only** when the username is
exactly `x-token-auth`; a legacy app password authenticates as an Atlassian
account instead and needs that account's real name, which is what the
per-connection *credential username* override is for.

**Registering a repository.** *Repositories* → paste the URL. The provider is
detected from the host, so `https://gitlab.com/acme/platform/store` is enough;
pick one by hand for a self-managed instance, whose hostname says nothing about
what is running on it. The connection is verified immediately — the token is
checked against the API, and the repository's real default branch is reported
back, because a `main`/`master` mismatch is the most common reason a first task
dies at clone time. A repository that cannot be reached is still saved, with the
reason shown.

**Verification commands are part of the connection.** Install, build, test and
lint are detected from the repository at registration time and prefilled into
the form; edit or clear them at any time. See
[`docs/verification.md`](docs/verification.md).

**One token per host is the default, not the rule.** A connection's *credential
variable* may name any environment variable of its own — `GITHUB_TOKEN_WORK`,
`BITBUCKET_TOKEN_ACME` — for a second account on the same host, or to keep a
client's token separate. It takes a variable *name*, and only a plausible one:
names the pipeline reserves for itself (`ANTHROPIC_API_KEY`, `PATH`,
`DATABASE_URL`, and the rest) are rejected, since otherwise the field would be a
way to hand any environment variable to a remote git server.

**Self-managed instances.** A self-managed **GitLab** is supported: choose the
provider explicitly and set *API base URL* to that instance's API root
(`https://git.acme.internal/api/v4`). Left empty, the public endpoint is used.

Bitbucket Data Center and Azure DevOps Server are not — both speak an API that
differs from their cloud siblings by more than a base URL. Register them as a
generic connection: cloning, branching and pushing all work, and you open the
pull request yourself.

## Running

```bash
npm run dev        # Next.js on :3000 and the worker, together
```

Or separately:

```bash
npm run dev:web
npm run dev:worker
```

Production:

```bash
npm run build      # next build + tsc for the worker
npm start          # next start + node dist/worker/index.js
```

Do not deploy this serverless. Agent sessions run for minutes and the dashboard
holds an SSE connection open; both need a persistent server. `docker-compose.yml`
covers the self-hosted case, and its worker healthcheck hits `GET /api/health`.

Other scripts:

```bash
npm run db:backup                    # online SQLite backup into data/backups/
npm run token:create -- --name=CI    # mint an API token (see docs/operations.md)
npm test
npm run lint
npm run typecheck
```

---

## The pipeline

```
CREATED
 └─► STAKEHOLDER_REFINEMENT   agent · brief.md
      └─► PO_REFINEMENT       agent · stories.md
           └─► ARCHITECTURE   agent · techplan.md
                └─► PLAN_GATE          human · approve / request changes / reject
                     │                        (request changes → ARCHITECTURE, unbudgeted)
                     └─► DEVELOPMENT   agent · commits + dev-report.md
                          └─► VERIFICATION  worker · install → build → test → lint
                               ├─ failed  → DEVELOPMENT  (no review or QA session paid)
                               ├─ errored → FAILED       (environment, not code)
                               ├─ skipped ─┐
                               └─ passed ──┴─► CODE_REVIEW  agent · code-review-report.md
                                                │            (skippable per settings)
                                                ├─ changes_requested → DEVELOPMENT
                                                └─► QA        agent · qa-report.md
                                                     ├─ changes_requested → DEVELOPMENT
                                                     └─► HUMAN_CODE_REVIEW   human · optional
                                                          ├─ request_changes → DEVELOPMENT
                                                          └─► PO_HOMOLOGATION  agent · homolog-report.md
                                                               ├─ rejected (1st pass, budget left) → DEVELOPMENT
                                                               ├─ rejected (2nd pass, or budget spent) ─┐
                                                               └─ accepted ──────────────────────────────┴─► STAKEHOLDER_GATE   human
                                                                    ├─ request_changes → DEVELOPMENT
                                                                    └─► DELIVERY  worker · push + change request
                                                                         └─► COMPLETED

Rework from any reviewer — VERIFICATION, CODE_REVIEW, QA, a human request_changes
and PO_HOMOLOGATION — shares one budget (reworkMaxCycles, extendable per task by a retry).
Other terminals: REJECTED (gate), FAILED (technical), CANCELLED (user)
```

| Stage | Consumes | Produces | Tools |
|---|---|---|---|
| Stakeholder | raw request, attachments | `brief.md` | none |
| Product Owner | `brief.md`, attachments + repo | `stories.md` | Read, Grep, Glob |
| Architect | `brief.md`, `stories.md`, document attachments + repo | `techplan.md` | + Bash (read-only) |
| Developer | `stories.md`, `techplan.md`, attachments (+ reviewer reports and its own last report on rework) | commits, `dev-report.md` | + Edit, Write |
| Verification | the repository's configured commands | `verification-report.md` | none — the worker, not an agent |
| Code Reviewer | `stories.md`, `techplan.md`, `dev-report.md`, branch diff (+ the incremental diff since its own last review) | `code-review-report.md` | Read, Grep, Glob, Bash |
| QA | `stories.md`, `dev-report.md`, branch diff, verification results | `qa-report.md` | Read, Grep, Glob, Bash |
| Homologation | `stories.md`, `qa-report.md`, diff summary, verification results | `homolog-report.md` | Read |

Every stage that has a workspace also receives the repository's own conventions
file — `AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`, first one
found — on every provider, not just Claude. (The Stakeholder has no workspace,
so its only context beyond the request is the attachments.)

Every artifact must contain a fixed set of `##` sections, validated by the worker
before the pipeline advances. A malformed artifact gets **one bounded repair
turn** — a toolless session shown its own rejected document and the exact
problems — and fails the stage only if the repair is also invalid. The code
review, QA and homologation verdicts all fail closed: anything that cannot be
parsed as a pass is treated as a rejection.

Role system prompts live in [`prompts/`](prompts/) as plain Markdown. Each file
is read once and cached for the life of the process, so restart the worker after
editing one.

### Verification

The pipeline — not an agent — runs the repository's configured install/build/
test/lint commands between Development and Code Review, and routes on the real
exit codes. A failure sends work straight back to the Developer with no reviewer
or QA session paid for; an install that cannot run at all is an *environment*
failure and fails the task rather than blaming the code. Commands are configured
per repository (autodetected at connection time, editable afterwards); a
repository with none configured is not blocked, it is `skipped` — visibly, never
rendered as a pass. Output streams to the live log, exit codes and durations are
persisted, and the summary is written into the pull request body.
Details: [`docs/verification.md`](docs/verification.md).

### Human decisions

| Gate | Decisions | `request_changes` goes to |
|---|---|---|
| `PLAN_GATE` | approve · request changes · reject | the **Architect** — a new plan attempt, and deliberately *not* charged to the rework budget |
| `HUMAN_CODE_REVIEW` | approve · request changes · reject | the Developer |
| `STAKEHOLDER_GATE` | approve · request changes · reject | the Developer |

Your comment is persisted as `human-review.md`, so it actually reaches the next
prompt rather than only the audit log. **Human code review is opt-in per task**,
chosen at creation; when enabled the task parks after QA until you read the diff
at `/tasks/{id}/review` and decide. While it is parked you can also fix one line
by hand in the workspace and commit it from that screen, instead of spending a
whole rework cycle.

The plan gate can be waived for low-criticality work (Settings → *Automatic plan
gate*). There is also an instance-wide **no-approval automation** switch that
skips both `PLAN_GATE` and `STAKEHOLDER_GATE` for every task — every skip is
recorded as a `gate_bypassed` event. One case stays gated regardless: a
homologation escalation, where the Product Owner rejected the work twice or the
rework budget is spent, always waits for a human.

`CODE_REVIEW` itself can be turned down: `always` (default), `auto` — skipped
when the Architect rated the task `S` and low criticality — or `never`.

### Delivery

The base branch is fetched at every workspace stage, not only at the first
clone, so a plan that sat at a gate for two days is still developed and reviewed
against current `main`.

**Delivery degrades rather than fails.** The branch is pushed first, then the
change request is opened through the provider's API. If that call fails — an
expired token, a host with no API at all — the push still stands and the task
completes, but it says so: the outcome is recorded as `manual`, with the reason,
and the link you get is the provider's own pre-filled "create pull request"
page. **Try again** re-runs only the change-request call against the branch that
is already pushed. When the request is opened for real, its number and state are
recorded alongside the URL.

### Retry and recovery

A failed task records *why* it failed — the stage that threw, an invalid
artifact, a Development run that left no commits, an exhausted rework budget, or
a delivery failure — and the retry re-runs the stage that cause implies. A retry
after an exhausted budget grants one extra rework cycle, so it does not walk
straight back into the same wall. The API reports retryability, so the button is
only offered when it will actually work; a retry that needs branch history no
longer on disk is refused with that reason rather than a generic conflict.

Terminal-but-not-failed tasks are not dead ends either: a rejected or cancelled
task can be moved back to **Created** from the card menu, keeping its brief,
stories and plan.

### Spend and operational control

- **Quota as an admission decision.** A configured limit can be `off` (a
  read-out, the default), `warn` (start proceeds, event recorded) or `hold`
  (start refused, with an explicit override available). Limits are per provider
  pool — Claude subscription, Claude API key, ChatGPT, Gemini — with a daily,
  hourly or monthly cadence.
- **Ceilings that stop work.** A per-stage dollar ceiling is enforced by every
  provider while the session runs; a per-task ceiling is checked before each
  stage is scheduled.
- **Cancel really cancels.** The running session is aborted, not just marked.
- **Pause one task, hold the whole queue.** Pause lets the current stage finish
  and then stops scheduling; the global hold stops the worker claiming anything
  new without touching what is already running.
- **The worker proves it is alive.** It writes a heartbeat; the nav shows its
  state and `GET /api/health` returns non-2xx when it is stale.
- **Notifications.** Desktop notifications (with explicit permission consent)
  and an outbound webhook with an optional HMAC signature, per event type —
  gates, finished tasks, opened pull requests and quota warnings are on by
  default.

Details: [`docs/operations.md`](docs/operations.md).

### The board

Search by text, filter by repository, priority and status, and pick a date
range; the same filter state drives a sortable, paginated list view at `/tasks`
for finding something you shipped last week. Cards say how long they have been
where they are, and cards in *Not delivered* say whether they failed, were
rejected or were cancelled, and why. Anything terminal can be archived — alone
or in a batch — which hides it from the board without touching a single row of
`/usage`. `/activity` is a cross-task event feed for everything happening at
once. Queued cards can be bumped to the front; tasks can depend on other tasks;
and the New Task form autosaves a draft, so a closed tab does not cost you the
description you just wrote.

### The audit trail

Every stage run stores the exact system and user prompt it was sent, the model
and provider that answered it, its token counts and cost, and its full
transcript — normalized across all three providers, secrets redacted, readable
at `/tasks/{id}/runs/{runId}`. Artifacts keep every version rather than only the
newest, so attempt 1 can be read against attempt 3. A `diff-summary.md` is
written at delivery so the shape of the change outlives the workspace. One task
exports as a single JSON file. Transcripts can be pruned on a retention schedule
that leaves a tombstone rather than a hole.
Details: [`docs/audit-trail.md`](docs/audit-trail.md).

---

## Layout

```
src/
├─ app/
│  ├─ (dashboard)/      board, list, new task, task detail, diff review,
│  │                    run transcripts, activity, repos, settings, costs
│  └─ api/              REST endpoints + the per-task and global SSE streams
├─ components/          UI
├─ proxy.ts             optional bearer-token gate in front of /api/*
├─ server/              shared by web and worker
│  ├─ agents/           role definitions: tools, prompts, artifact contracts
│  ├─ auth/             API token hashing, verification, actor labels
│  ├─ config/           environment resolution, provider and model tiers
│  ├─ db/               Drizzle schema, lazy SQLite client, migrations
│  ├─ events/           append-only event log behind the SSE streams
│  ├─ git/              workspace clone/fetch/branch/commit/push, diffs, credentials
│  │  └─ providers/     one module per host, behind a common interface
│  ├─ http/             route-handler helpers
│  ├─ jobs/             SQLite-backed job queue
│  ├─ notifications/    outbound webhook dispatch
│  ├─ pipeline/         state machine, stage execution, artifacts, guardrails
│  │  ├─ audit/         transcript normalization, redaction, export, retention
│  │  └─ providers/     one module per LLM backend: claude, chatgpt, gemini
│  ├─ settings/         runtime settings store
│  ├─ tasks/            data access
│  ├─ usage/            quota math and CSV export
│  ├─ validation/       Zod schemas shared by API and forms
│  └─ worker/           heartbeat and liveness
└─ worker/index.ts      the long-running orchestrator
docs/                   setup and operations guides
prompts/                role system prompts
scripts/                db backup, API token creation
workspaces/             one clone per task (gitignored)
data/                   SQLite file (gitignored)
tests/                  Vitest
site/                   the public landing page — a separate static build
```

[`site/`](site/) is the GitHub Pages front page: its own Next.js app, its own
dependencies, `output: "export"`. It shares the dashboard's palette by copying
it, and imports nothing from `src/` — the pipeline needs SQLite, a worker and a
live SSE connection, none of which survive a static export. It is published by
[`.github/workflows/deploy-site.yml`](.github/workflows/deploy-site.yml) on every
push to `main` that touches it.

### Why two processes

A stage takes minutes and streams continuously — that does not fit a Next.js
request/response cycle. The worker owns all execution and all state transitions;
the web app only reads state, records gate decisions, and cancels. They
communicate through the database: a `jobs` table the worker polls, and an
`events` table the SSE routes tail. SQLite runs in WAL mode with a busy timeout,
which is what makes two writer processes on one file safe.

## API

Full reference, including request bodies and status codes:
[`docs/api.md`](docs/api.md).

| Method / route | Purpose |
|---|---|
| `POST /api/tasks` | Create a task (JSON or multipart with attachments); enters the pipeline only with `start: true` |
| `GET /api/tasks?status=` | List for the board, plus capacity and execution state |
| `POST /api/tasks/:id/start` | Start a queued task (admission + quota controlled) |
| `PATCH` / `DELETE /api/tasks/:id` | Edit or delete a task that has not started |
| `GET /api/tasks/:id` | Detail: stage, runs, artifacts, approvals, dependencies, cost, retryability |
| `GET /api/tasks/:id/stream` | **SSE** — this task's event tail, resumable via `Last-Event-ID` |
| `GET /api/events/stream` | **SSE** — the event tail across every task |
| `GET /api/tasks/:id/diff` | Changed-file index, or one file's patch with `?file=` |
| `POST /api/tasks/:id/gates/:gate` | Record a human decision |
| `POST /api/tasks/:id/retry` | Re-run the failed stage |
| `POST /api/tasks/:id/deliver-retry` | Re-attempt only the change-request call |
| `POST /api/tasks/:id/cancel` | Cancel, aborting the running stage |
| `POST /api/tasks/:id/pause` · `/resume` | Stop after the current stage, then continue |
| `POST /api/tasks/:id/run-next` | Bump a queued task to the front |
| `POST /api/tasks/:id/archive` · `/unarchive` · `/reopen` | Hide, restore, or send a terminal task back to Created |
| `POST /api/tasks/batch-start` · `batch-archive` · `batch-cancel` | The same, for a selection |
| `GET /api/tasks/:id/runs/:runId/transcript` | One stage run's normalized transcript, paginated |
| `GET /api/tasks/:id/artifacts/:artifactId` | One artifact version |
| `GET` / `DELETE /api/tasks/:id/attachments/:attachmentId` | Download or remove an attachment |
| `GET /api/tasks/:id/workspace/status` · `POST .../commit` | Uncommitted changes at the review gate, and committing them |
| `GET /api/tasks/:id/export` | The whole task record as one JSON file |
| `GET` / `POST /api/repos` | List connections, or register one (provider detected, access verified) |
| `GET` / `PATCH` / `DELETE /api/repos/:id` | Connection detail with a live access check; edit verification commands; delete if unused |
| `GET` / `PATCH /api/settings` | Provider and model per role, turn ceilings, limits, notifications |
| `POST /api/settings/test-provider` | Send one message to an LLM provider and return its reply |
| `POST /api/settings/vacuum` | Reclaim space after a retention sweep |
| `GET /api/usage?days=&taskId=` | Token and cost aggregates |
| `GET /api/usage/export?days=&taskId=` | One CSV row per stage run |
| `GET /api/health` | Worker liveness — non-2xx when the heartbeat is stale |

`/api/*` is open by default. Create a token with `npm run token:create` and
every request needs `Authorization: Bearer <secret>` from then on — see
[`docs/operations.md`](docs/operations.md).

## Configuration

`.env` supplies defaults; the Settings screen overrides them per install, and the
worker re-reads them at the start of every job.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription credential (default provider) |
| `ANTHROPIC_API_KEY` | — | Claude pay-per-use alternative |
| `OPENAI_API_KEY` | — | ChatGPT credential; only needed if a role's provider is set to ChatGPT |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Gemini credential; only needed if a role's provider is set to Gemini |
| `GITHUB_TOKEN` | — | GitHub PAT, worker only |
| `GITLAB_TOKEN` | — | GitLab token, worker only |
| `BITBUCKET_TOKEN` | — | Bitbucket Cloud token, worker only |
| `AZURE_DEVOPS_TOKEN` | — | Azure DevOps PAT, worker only |
| `GIT_TOKEN` | — | Suggested fallback for a generic server |
| `DATABASE_URL` | `file:./data/pipeline.db` | SQLite file |
| `WORKSPACES_DIR` | `./workspaces` | Where task clones live |
| `APP_URL` | `http://localhost:3000` | Where the dashboard is reachable, for webhook payload links |
| `MAX_PARALLEL_TASKS` | `1` | Keep at 1 on a subscription |
| `REWORK_MAX_CYCLES` | `2` | Shared rework budget (old `QA_MAX_CYCLES` still read) |
| `MODEL_LIGHT` / `MODEL_DEFAULT` / `MODEL_HEAVY` | `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-5` | Claude's model tiers; ChatGPT and Gemini have their own fixed tier tables |
| `WORKSPACE_RETENTION_DAYS` | `7` | How long a finished clone is kept |
| `TRANSCRIPT_RETENTION_DAYS` | *(unset — forever)* | How long full transcripts are kept |
| `QUOTA_SUBSCRIPTION_LIMIT_USD` / `_CADENCE` | — / `daily` | Claude subscription quota pool |
| `QUOTA_API_KEY_LIMIT_USD` / `_CADENCE` | — / `daily` | Claude API-key quota pool |
| `QUOTA_CHATGPT_LIMIT_USD` / `_CADENCE` | — / `daily` | ChatGPT quota pool |
| `QUOTA_GEMINI_LIMIT_USD` / `_CADENCE` | — / `daily` | Gemini quota pool |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `All My Fellas Pipeline` / `pipeline@localhost` | Who the pipeline's commits are attributed to |

Everything above that is a *limit* is also a Settings field, alongside knobs
that exist only there: provider and model tier per role, per-stage turn
ceilings, quota enforcement mode and warning threshold, per-stage spend ceiling,
automatic plan gate, no-approval automation, code review mode, human code review
default, queue hold, theme, and notification routing.

## Tests

```bash
npm test
```

Covers the state machine (rework budget, gate rules, reviewer and homologation
verdicts, retry targets), artifact validation and repair, admission control,
quota enforcement and job ordering, the verification runner and its process-tree
kill, the diff parser against a real git repository, the sandbox guardrails and
secret redaction, transcript normalization and export, the board's filtering and
draft storage, and the provider layer — URL parsing per host, credential
resolution, and that no secret survives into a clone URL, a log line or a
browser link.

## Local commit checks

`git commit` runs a [Husky](https://typicode.github.io/husky/) `pre-commit` hook
that builds the project (`npm run build`), runs the unit test suite (`npm test`)
and lints (`npm run lint`), in that order, stopping at the first failure. A
commit is only created once all three pass. The hook is scoped to the root
project only — it does not run or block on the `site/` sub-project's own
scripts.

The hook installs itself: `npm install` runs the root `prepare` script, which
sets up `.husky/`, so there is no separate setup step after cloning.

## Known limits

- Single user, no authentication on the UI. The optional API token gates
  `/api/*` only. Do not expose the port publicly.
- The pipeline opens the change request; **merging is always manual**, on the
  host. A pull request's state is recorded when it is opened and nothing polls
  it forward afterwards.
- A generic connection has no API: the branch is pushed and the pull request is
  yours to open.
- Auto-detection covers the public hosts only, and of the self-hosted editions
  only GitLab has an API integration. GitHub Enterprise Server, Bitbucket Data
  Center and Azure DevOps Server run as generic connections.
- Image attachments are stored, listed and downloadable, but do not reach a
  prompt — only text-shaped kinds (JSON, XML, extracted PDF text) do.
- Two settings exist in the store with no way to change them: the board's
  refresh interval is read but never written, and auto-archive has no sweep
  behind it — archiving is manual.
- Cost figures for Claude come from the Agent SDK's own `total_cost_usd`; in
  subscription mode they are an estimate of equivalent API spend, not a bill.
  For ChatGPT and Gemini, cost is computed locally from a static price table
  (`src/server/pipeline/providers/pricing.ts`) since neither API reports a
  dollar figure — treat it as an estimate, not a bill, and expect it to drift
  as providers reprice. See [`docs/llm-providers.md`](docs/llm-providers.md)
  for the full list of behavior differences between providers.
