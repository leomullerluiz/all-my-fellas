# Multi-Agent Delivery Pipeline - All My Fellas

A local application that runs a software delivery pipeline staffed entirely by
Claude agents. You describe a feature; the task walks a pipeline that simulates
a full team — **Stakeholder → Product Owner → Architect → Developer → QA →
Homologation** — and the result arrives as a branch and a pull request on a real
GitHub repository.

Built with Next.js (UI + API), a separate Node worker process, SQLite, and the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

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
require a human decision. Everything in between runs unattended.

**Least privilege per role.** Only the Developer can write files. The Architect
and QA get Bash restricted to an inspection allowlist. The Stakeholder gets no
filesystem at all. Every tool call — including the Developer's edits — passes
through a `canUseTool` guard that confines paths to the task workspace and
blocks destructive or credential-touching commands.

**The agents never hold credentials.** Cloning, pushing and opening the pull
request are done by the worker. The GitHub token is injected into a remote URL
for the length of a single command and is never written to `.git/config`, the
database, or an agent's environment.

---

## Requirements

- Node.js ≥ 20.9
- `git` on `PATH`
- [`gh`](https://cli.github.com/) on `PATH` — optional. Without it the branch is
  still pushed and you get a "create pull request" link instead.
- A Claude credential (see below)

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

### GitHub

Create a Personal Access Token with the minimum `repo` scope and put it in
`.env` as `GITHUB_TOKEN`. It stays in the worker's environment; it is never
stored in the database and never reaches an agent.

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
                └─► PLAN_GATE            human · approve / reject
                     └─► DEVELOPMENT     agent · commits + dev-report.md
                          └─► QA         agent · qa-report.md
                               ├─ changes_requested → DEVELOPMENT (max N cycles)
                               └─► PO_HOMOLOGATION  agent · homolog-report.md
                                    └─► STAKEHOLDER_GATE   human
                                         └─► DELIVERY      worker · push + PR
                                              └─► COMPLETED

Other terminals: REJECTED (gate), FAILED (technical), CANCELLED (user)
```

| Stage | Consumes | Produces | Tools |
|---|---|---|---|
| Stakeholder | raw request | `brief.md` | none |
| Product Owner | `brief.md` + repo | `stories.md` | Read, Grep, Glob |
| Architect | `brief.md`, `stories.md` + repo | `techplan.md` | + Bash (read-only) |
| Developer | `stories.md`, `techplan.md` (+ `qa-report.md` on rework) | commits, `dev-report.md` | + Edit, Write |
| QA | `stories.md`, `dev-report.md`, branch diff | `qa-report.md` | Read, Grep, Glob, Bash |
| Homologation | `stories.md`, `qa-report.md`, diff summary | `homolog-report.md` | Read |

Every artifact must contain a fixed set of `##` sections, validated by the worker
before the pipeline advances. A malformed artifact fails the stage rather than
being passed on. The QA and homologation verdicts fail closed: anything that
cannot be parsed as a pass is treated as a rejection.

The plan gate can be waived for low-criticality work (Settings → *Automatic plan
gate*); the delivery gate is always manual.

Role system prompts live in [`prompts/`](prompts/) as plain Markdown — edit them
and the next stage run picks the change up.

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
│  ├─ git/              workspace clone/branch/commit/push, pull requests
│  ├─ http/             route-handler helpers
│  ├─ jobs/             SQLite-backed job queue
│  ├─ pipeline/         state machine, stage execution, artifacts, guardrails
│  ├─ settings/         runtime settings store
│  ├─ tasks/            data access
│  └─ validation/       Zod schemas shared by API and forms
└─ worker/index.ts      the long-running orchestrator
prompts/                role system prompts
workspaces/             one clone per task (gitignored)
data/                   SQLite file (gitignored)
tests/                  Vitest
```

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
| `POST /api/tasks/:id/gates/:gate` | Record a human decision |
| `POST /api/tasks/:id/retry` | Re-run the failed stage |
| `POST /api/tasks/:id/cancel` | Cancel |
| `GET / POST /api/repos`, `GET / DELETE /api/repos/:id` | Repository connections |
| `GET / PATCH /api/settings` | Models per role, turn ceilings, limits |
| `GET /api/usage?days=&taskId=` | Token and cost aggregates |

## Configuration

`.env` supplies defaults; the Settings screen overrides them per install, and the
worker re-reads them at the start of every job.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Subscription credential |
| `ANTHROPIC_API_KEY` | — | Pay-per-use alternative |
| `GITHUB_TOKEN` | — | PAT with `repo` scope, worker only |
| `DATABASE_URL` | `file:./data/pipeline.db` | SQLite file |
| `WORKSPACES_DIR` | `./workspaces` | Where task clones live |
| `MAX_PARALLEL_TASKS` | `1` | Keep at 1 on a subscription |
| `QA_MAX_CYCLES` | `2` | QA → Developer rework budget |
| `MODEL_LIGHT` / `MODEL_DEFAULT` / `MODEL_HEAVY` | `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-5` | Model tiers |
| `WORKSPACE_RETENTION_DAYS` | `7` | How long a finished clone is kept |

## Tests

```bash
npm test
```

Covers the state machine (including the QA rework budget and gate rules),
artifact validation and verdict parsing, and the sandbox guardrails.

## Known limits

- GitHub only. GitLab and Bitbucket are not implemented.
- Single user, no authentication. Do not expose the port publicly.
- The pipeline opens pull requests; **merging is always manual, on GitHub**.
- Cost figures come from the Agent SDK's own `total_cost_usd`; in subscription
  mode they are an estimate of equivalent API spend, not a bill.
