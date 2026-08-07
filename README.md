# Multi-Agent Delivery Pipeline - All My Fellas

A local application that runs a software delivery pipeline staffed by LLM
agents. You describe a feature; the task walks a pipeline that simulates a
full team — **Stakeholder → Product Owner → Architect → Developer → Code
Review → QA → Homologation** — and the result arrives as a branch and an open
pull request (a *merge request*, on GitLab) against a real repository: GitHub,
GitLab, Bitbucket, Azure DevOps, or any plain git server.

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
for you. Your job is to read the plan and say yes or no. Reading a plan is
cheaper than writing one, and far cheaper than finding out the approach was
wrong on a finished branch.

**A reviewer that shares your context is not a reviewer.** Ask one session to
write the code and then check it, and the check is performed by the thing that
already talked itself into the code — it re-reads its intentions rather than its
output. The Code Reviewer and QA are separate `query()` calls that never see the
Developer's transcript. What they get is the acceptance criteria, the
Developer's written report and the branch diff, and the verdict fails closed: a
report that cannot be parsed as an approval counts as changes requested. The
independence is in the context, not the model — development and code review
default to the same tier.

**Your attention goes to decisions, not turns.** Two of them by default, the
technical plan and delivery, plus a diff review if the task opted into one. Each
is a document you read on your own schedule rather than a session you supervise
turn by turn, and the work carries on while you are doing something else.

**A wrong turn costs one stage, not the run.** Every agent stage leaves a
validated artifact, so a retry re-runs that stage as a new attempt recorded
beside the failure — the brief, stories and plan you already paid for survive,
and so do the clone and the branch. The same trail is what lets you ask later
why something was built rather than only what changed, and lets `/usage` tell
you which stage spent your money.

A one-line fix is faster by hand than seven agent stages and two gates. This
earns its cost on work you would have written a plan for anyway.

---

## What makes it different

**It reads the real code.** The Architect explores the repository before
choosing an approach, so its difficulty and criticality estimates come from what
is actually there rather than from the prompt alone.

**Minimum-context handoff.** Each stage is a brand-new `query()` session with no
`resume`. A stage's prompt is assembled from three things only: the role's
system prompt, the task metadata, and the specific Markdown artifacts the
previous stages produced. No agent ever sees another agent's transcript. Full
transcripts are kept in `agent_runs` for auditing and are never fed back into
the pipeline.

**Nothing starts on its own.** A new task sits in the **Created** column until
you start it, and at most `MAX_PARALLEL_TASKS` tasks are ever in flight — the
limit is enforced when you press Start, not deep inside the worker, so a card
that says "an agent is running" means exactly that.

**Human gates where they matter.** The technical plan and the final delivery both
require a human decision, and a task can opt into a third between them: a human
code review of the diff. Everything else runs unattended.

**Least privilege per role.** Only the Developer can write files. The Architect
and QA get Bash restricted to an inspection allowlist. The Stakeholder gets no
filesystem at all. Every tool call — including the Developer's edits — passes
through a `canUseTool` guard that confines paths to the task workspace and
blocks destructive or credential-touching commands.

**The agents never hold credentials.** Cloning, pushing and opening the change
request are done by the worker. The token is injected into a remote URL — or an
`Authorization` header, for Azure DevOps — for the length of a single command,
and is never written to `.git/config`, the database, or an agent's environment.
What the database stores is the *name* of an environment variable, never its
value.

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

Full setup steps, how to select a provider per role, and the known behavior
differences between providers (cost reporting, tool-execution maturity, event
granularity) are in [`docs/llm-providers.md`](docs/llm-providers.md).

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
covers the self-hosted case.

---

## The pipeline

```
CREATED
 └─► STAKEHOLDER_REFINEMENT   agent · brief.md
      └─► PO_REFINEMENT       agent · stories.md
           └─► ARCHITECTURE   agent · techplan.md
                └─► PLAN_GATE          human · approve / reject
                     └─► DEVELOPMENT   agent · commits + dev-report.md
                          └─► VERIFICATION  worker · install → build → test → lint
                               ├─ failed  → DEVELOPMENT  (no review or QA session paid)
                               ├─ errored → FAILED       (environment, not code)
                               ├─ skipped ─┐
                               └─ passed ──┴─► CODE_REVIEW  agent · code-review-report.md
                                                ├─ changes_requested → DEVELOPMENT
                                                └─► QA        agent · qa-report.md
                                                     ├─ changes_requested → DEVELOPMENT
                                                     └─► HUMAN_CODE_REVIEW   human · optional
                                                          ├─ request_changes → DEVELOPMENT
                                                          └─► PO_HOMOLOGATION  agent
                                                               └─► STAKEHOLDER_GATE   human
                                                                    └─► DELIVERY  worker · push + change request
                                                                         └─► COMPLETED

Rework from any reviewer — including VERIFICATION — shares one budget (REWORK_MAX_CYCLES).
Other terminals: REJECTED (gate), FAILED (technical), CANCELLED (user)
```

| Stage | Consumes | Produces | Tools |
|---|---|---|---|
| Stakeholder | raw request | `brief.md` | none |
| Product Owner | `brief.md` + repo | `stories.md` | Read, Grep, Glob |
| Architect | `brief.md`, `stories.md` + repo | `techplan.md` | + Bash (read-only) |
| Developer | `stories.md`, `techplan.md` (+ reviewer reports on rework) | commits, `dev-report.md` | + Edit, Write |
| Verification | repository's configured commands | `verification-report.md` | none — the worker, not an agent |
| Code Reviewer | `stories.md`, `techplan.md`, `dev-report.md`, branch diff | `code-review-report.md` | Read, Grep, Glob, Bash |
| QA | `stories.md`, `dev-report.md`, branch diff, verification results | `qa-report.md` | Read, Grep, Glob, Bash |
| Homologation | `stories.md`, `qa-report.md`, diff summary, verification results | `homolog-report.md` | Read |

**Verification runs before code review, mechanically.** The pipeline — not an
agent — runs this repository's configured install/build/test/lint commands
between Development and Code Review, and routes on the real exit codes: a
failure sends work straight back to the Developer with no reviewer or QA
session paid for. QA and homologation receive the real results as an input;
neither claims to have run the checks itself, and QA's prompt stays narrow —
it verifies acceptance criteria and does not re-review code quality. Commands
are configured per repository (autodetected at connection time, editable
afterwards); a repository with none configured is not blocked, it is
`skipped` — visibly, never rendered as a pass.

**Human code review is opt-in per task**, chosen at creation. When enabled the
task parks after QA until you read the diff at `/tasks/{id}/review` and decide.
*Request changes* sends the work back to the Developer, and your comment is
persisted as `human-review.md` so it actually reaches their prompt.

Every artifact must contain a fixed set of `##` sections, validated by the worker
before the pipeline advances. A malformed artifact fails the stage rather than
being passed on. The QA and homologation verdicts fail closed: anything that
cannot be parsed as a pass is treated as a rejection.

The plan gate can be waived for low-criticality work (Settings → *Automatic plan
gate*); the delivery gate is always manual.

**Delivery degrades rather than fails.** The branch is pushed first, then the
change request is opened through the provider's API. If that call fails — an
expired token, a host with no API at all — the push still stands and the task
completes with a link to the provider's own "create pull request" page,
pre-filled with the two branches.

Role system prompts live in [`prompts/`](prompts/) as plain Markdown. Each file
is read once and cached for the life of the process, so restart the worker after
editing one.

---

## Layout

```
src/
├─ app/
│  ├─ (dashboard)/      board, new task, task detail, repos, settings, costs
│  └─ api/              REST endpoints + the SSE stream
├─ components/          UI
├─ server/              shared by web and worker
│  ├─ agents/           role definitions: tools, prompts, artifact contracts
│  ├─ config/           environment resolution
│  ├─ db/               Drizzle schema, lazy SQLite client, bootstrap DDL
│  ├─ events/           append-only event log behind the SSE stream
│  ├─ git/              workspace clone/branch/commit/push, diffs, credentials
│  │  └─ providers/     one module per host, behind a common interface
│  ├─ http/             route-handler helpers
│  ├─ jobs/             SQLite-backed job queue
│  ├─ pipeline/         state machine, stage execution, artifacts, guardrails
│  │  └─ providers/     one module per LLM backend: claude, chatgpt, gemini
│  ├─ settings/         runtime settings store
│  ├─ tasks/            data access
│  └─ validation/       Zod schemas shared by API and forms
└─ worker/index.ts      the long-running orchestrator
docs/                   llm-providers.md — per-provider setup
prompts/                role system prompts
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
`events` table the SSE route tails. SQLite runs in WAL mode with a busy timeout,
which is what makes two writer processes on one file safe.

## API

| Method / route | Purpose |
|---|---|
| `POST /api/tasks` | Create a task; enters the pipeline only with `start: true` |
| `GET /api/tasks?status=` | List for the board, plus current capacity |
| `POST /api/tasks/:id/start` | Start a queued task (admission controlled) |
| `PATCH /api/tasks/:id` | Edit a task that has not started |
| `DELETE /api/tasks/:id` | Delete a task that has not started |
| `GET /api/tasks/:id` | Detail: stage, runs, artifacts, approvals, cost |
| `GET /api/tasks/:id/stream` | **SSE** — live event tail, resumable via `Last-Event-ID` |
| `GET /api/tasks/:id/diff` | Changed-file index, or one file's patch with `?file=` |
| `POST /api/tasks/:id/gates/:gate` | Record a human decision |
| `POST /api/tasks/:id/retry` | Re-run the failed stage |
| `POST /api/tasks/:id/cancel` | Cancel |
| `GET / POST /api/repos` | List connections, or register one (provider detected, access verified) |
| `GET / DELETE /api/repos/:id` | Connection detail with a live access check; delete if unused |
| `GET / PATCH /api/settings` | Provider and model per role, turn ceilings, limits |
| `GET /api/usage?days=&taskId=` | Token and cost aggregates |

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
| `MAX_PARALLEL_TASKS` | `1` | Keep at 1 on a subscription |
| `REWORK_MAX_CYCLES` | `2` | Shared rework budget (old `QA_MAX_CYCLES` still read) |
| `MODEL_LIGHT` / `MODEL_DEFAULT` / `MODEL_HEAVY` | `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-5` | Model tiers |
| `WORKSPACE_RETENTION_DAYS` | `7` | How long a finished clone is kept |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `All My Fellas Pipeline` / `pipeline@localhost` | Who the pipeline's commits are attributed to |

## Tests

```bash
npm test
```

Covers the state machine (rework budget, gate rules, reviewer verdicts),
artifact validation, admission control and job ordering, the diff parser against
a real git repository, the sandbox guardrails, and the provider layer — URL
parsing per host, credential resolution, and that no secret survives into a
clone URL, a log line or a browser link.

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

- Single user, no authentication. Do not expose the port publicly.
- The pipeline opens the change request; **merging is always manual**, on the
  host.
- A generic connection has no API: the branch is pushed and the pull request is
  yours to open.
- Auto-detection covers the public hosts only, and of the self-hosted editions
  only GitLab has an API integration. GitHub Enterprise Server, Bitbucket Data
  Center and Azure DevOps Server run as generic connections.
- Cost figures for Claude come from the Agent SDK's own `total_cost_usd`; in
  subscription mode they are an estimate of equivalent API spend, not a bill.
  For ChatGPT and Gemini, cost is computed locally from a static price table
  (`src/server/pipeline/providers/pricing.ts`) since neither API reports a
  dollar figure — treat it as an estimate, not a bill, and expect it to drift
  as providers reprice. See [`docs/llm-providers.md`](docs/llm-providers.md)
  for the full list of behavior differences between providers.
