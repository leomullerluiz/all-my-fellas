# Delivery Lifecycle — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Everything between "the agent wrote code" and "the change is
> merged". Fetching the base branch so the work is not built against a frozen
> clone, telling the truth when the pull request was not opened, tracking it
> after it is, and giving PR feedback a way back into the pipeline.
> **Prerequisite:** the pipeline as built, and `spec-execution-honesty.md`,
> whose provider-neutral copy rule §3.2 here relies on rather than repeats.
> **Related:** `spec-multi-provider-repositories.md` (§4.1 — the
> `RepositoryProvider` interface §5 extends; §3.3 — the PR API matrix §5.2
> works from); `spec-code-review.md` (§10 the diff viewer, §6.3 the
> comment-as-artifact channel §6 reuses); `spec-task-queue.md` (§7.2 —
> deletion is `CREATED`-only, which §8.3 revisits for connections);
> `spec-human-in-the-loop.md` (§7 — the workspace affordances at the review
> gate, which §4 here makes safe by keeping the base fresh);
> `spec-audit-trail.md` (§6 — the `diff_summary` artifact that outlives the
> workspace); `spec-retry-recovery.md` (§5 — a delivery failure is one of the
> terminal causes it enumerates).

---

## 1. Summary

`executeDelivery` (`execute.ts:342-401`) pushes the branch, calls the provider's
API, writes a URL to `tasks.pr_url`, and the task reaches `COMPLETED`. From that
instant the application never looks at the change again.

Four things are wrong with the edges of that flow.

**The clone is frozen.** There is no `fetch`, no `pull`, no `merge-base` and no
`rebase` anywhere under `src/server/git` or `src/server/pipeline`.
`prepareWorkspace` (`workspace.ts:74-119`) clones once — at the first stage with
`needsWorkspace: true`, which is `PO_REFINEMENT` (`roles.ts:57`), the *second*
agent stage — and every later stage reuses that directory. `origin/<base>` is
whatever it was at clone time, forever. A plan gate parked for two days means
the Developer codes against stale `main`, the Code Reviewer and QA review a diff
computed against stale `main` (`diff.ts:138-140`), and the pull request opens
against a base that has moved underneath all of it.

**A failed PR looks like a successful one.** `createChangeRequest` returns a
discriminated union — `{status:"created", url}` or `{status:"manual", url,
reason}` (`pull-request.ts:14-16`) — and `executeDelivery` collapses it: both
branches write to the same `tasks.pr_url` column (`execute.ts:373`). The manual
branch's URL is `manualCreateUrl`, a *compare* page (`github.ts:103-108`). So
the task goes green, and the detail page renders a link labelled "Open pull
request ↗" (`tasks/[id]/page.tsx:105-115`) pointing at a form the user has to
fill in themselves. The only signal is a `warn` in the live log
(`execute.ts:378-385`). A missing credential takes the same path
(`pull-request.ts:92-99`).

**The PR is never read back.** Only the URL is stored. The number already comes
back — `githubProvider.createChangeRequest` returns `{ url, id: data.number }`
(`github.ts:100`), typed as `ChangeRequestRef` (`providers/types.ts:79`) — and
`executeDelivery` uses `change.url` and discards `change.id`. There is no
`readChangeRequest` in the provider contract, so CI status, review state and
merge state are invisible.

**Feedback has no way back.** `COMPLETED` is terminal (`stages.ts:31-42`). Red
CI or a human review comment on the PR cannot reach the Developer, even though
the workspace and branch are still on disk for the whole retention window
(`execute.ts:404-412`).

---

## 2. Scope

**In scope**

- Fetching and re-basing the task branch on the current base (§4).
- Distinguishing an opened change request from a pushed branch (§3).
- Reading the change request back: state, checks, merge (§5).
- Reopening a delivered task from PR feedback (§6).
- Per-task base branch, and what it means for dependent tasks (§7).
- PR shape: draft, reviewers, labels, template, branch prefix, title (§8).
- Editing and re-testing a repository connection (§9).

**Out of scope**

- Merging automatically. §5.6 argues the button is right and the automation is
  not, for a product whose whole thesis is human gates.
- Line-level review comments authored in this app.
  `spec-human-in-the-loop.md` §7.5 argues the host's UI plus §6 here is
  strictly better.
- Persisting the diff so it survives workspace cleanup —
  `spec-audit-trail.md` §6 owns the `diff_summary` artifact, which
  `spec-code-review.md:352` originally specified. §5.5 depends on it and does
  not duplicate it.
- New git providers. The five in `PROVIDERS` (`git/providers/index.ts:15-21`)
  are the set; §5.2 states what each can and cannot support.

---

## 3. Say when the pull request was not opened

### 3.1 One column, two meanings

`tasks.pr_url` (`schema.ts:66`) holds either a real change request or a
pre-filled creation form, and nothing records which. Every consumer therefore
guesses wrong: the detail page labels it "Open {noun} ↗", the board would treat
its presence as delivery, and a future PR poller (§5) would fetch a compare URL.

The fix is to stop overloading the column.

```ts
// migrations.ts — appended entry, addColumn is idempotent
addColumn(sqlite, "tasks", "pr_state", "TEXT");      // NULL | 'open' | 'merged' | 'closed'
addColumn(sqlite, "tasks", "pr_number", "INTEGER");
addColumn(sqlite, "tasks", "delivery_outcome", "TEXT"); // 'created' | 'manual'
addColumn(sqlite, "tasks", "delivery_reason", "TEXT");  // why manual
```

`delivery_outcome` is the discriminator `createChangeRequest` already computes
and `executeDelivery` throws away. `pr_url` keeps its meaning only when the
outcome is `created`; when it is `manual`, the URL is a compare link and is
rendered as one.

### 3.2 What the UI says

When `delivery_outcome === 'manual'`, the detail page shows a banner rather than
a link:

> **Branch pushed — the pull request was not opened.**
> *The credential was rejected (401).*
> [Open the compare page ↗] [Try again]

"Try again" re-runs only the change-request call against the branch that is
already pushed. It is not a retry of the whole `DELIVERY` stage: the push
succeeded, and `pushBranch` on an unchanged branch is a no-op that would still
cost a network round trip and a stage run row.

The noun in every string comes from `providerFor(repo.provider).changeRequestNoun`
— the rule `spec-execution-honesty.md` §4 establishes and this spec follows
rather than restates.

### 3.3 Should a manual outcome still complete the task?

Yes. The branch is pushed and the work is reachable; failing the task would
discard a completed pipeline over a network error, and
`pull-request.ts:71-76` already documents that reasoning ("Delivery must not
fail because an API call did").

What changes is that `COMPLETED` stops implying "a pull request exists". The
board's terminal column shows the distinction, and §5.4's "Delivered" state is
what carries the stronger claim.

---

## 4. Keeping the base branch current

### 4.1 How stale it gets

The clone is created once, with `--depth 50` (`workspace.ts:96`), and
`prepareWorkspace` short-circuits on every later call:

```ts
if (!(await pathExists(path.join(target, ".git")))) { /* clone */ }
```

Every diff in the product is computed as `origin/<base>...HEAD`
(`workspace.ts:132`, `:144`, `diff.ts:138-140`) against that frozen ref. The
gap between clone time and delivery is at minimum the length of the pipeline
and at maximum unbounded, because `PLAN_GATE` and `STAKEHOLDER_GATE` wait for a
human.

### 4.2 When to fetch

At the start of every stage that needs a workspace — inside `prepareWorkspace`,
after the checkout, so there is exactly one place that owns freshness:

```ts
await simpleGit(target).raw([...transport.configArgs, "fetch", "--depth", "50", transport.url, options.defaultBranch]);
```

The fetch uses the same `provider.transport(...)` credential attachment as the
clone and the push (`workspace.ts:88`, `:188`), so the token continues to exist
only inside one argv and never reaches `.git/config` — the invariant
`workspace.ts:10-20` documents.

A fetch failure is **not** fatal. An offline moment should not fail a task whose
work is otherwise fine; the stage proceeds against the last known base, and a
`git` event records that the base is stale. This mirrors how
`diffAgainstBase` already swallows errors and returns `""` (`workspace.ts:133-135`)
— though §11.2 notes that swallowing is itself a defect in the diff case.

### 4.3 Fetch is not enough: the divergence decision

Fetching updates `origin/main` and therefore changes what `origin/main...HEAD`
means. That alone is an improvement — reviewers see a diff against reality — but
it also means the Developer's branch can become un-mergeable while the task
sits at a gate.

Three options:

- **Fetch only.** Cheap, honest, and leaves conflicts for the human at the PR.
- **Rebase the task branch onto the fetched base.** Produces a clean PR, and
  rewrites history the reviewer may have already read.
- **Merge the base into the task branch.** Preserves history, adds a merge
  commit to a feature branch, and pollutes the diff with unrelated changes.

**Fetch always; rebase only at delivery, and only when it is clean.**

At `DELIVERY`, before the push, attempt `git rebase origin/<base>`. If it
applies cleanly, push the rebased branch — the PR is then mergeable and its diff
is minimal. If it conflicts, abort the rebase, push the original branch, and
open the PR anyway with a note in the body that the base has moved and the
change requires a manual merge. A conflicted rebase is a human decision, and an
agent resolving conflicts unsupervised at the last stage of the pipeline is
exactly the kind of unattended risk the gates exist to prevent.

### 4.4 `--depth 50` and rebase

A shallow clone can rebase only within its own history. If the base has moved
more than 50 commits, `git rebase` fails for lack of a merge base rather than
for a conflict.

Deepening on demand — `git fetch --deepen 200`, retried once — is preferable to
raising the initial depth for every clone, because the common case is a base
that moved by a handful of commits and the uncommon case is a busy repository
where a full clone would be expensive anyway. If the deepen still leaves no
merge base, treat it exactly as a conflict (§4.3).

### 4.5 What this changes for reviewers

A moved base changes the diff the Code Reviewer and QA already approved. A task
that passed review on Monday against `main@abc` is delivered on Wednesday
against `main@xyz`, and the difference was never reviewed.

This spec does not solve that — it is the same class of problem as
`spec-code-review.md` §15.5's incremental-review question — but it does make it
*visible*: the delivery gate panel shows how far the base has moved since the
last review (`git rev-list --count <reviewed-sha>..origin/<base>`) so the
approver knows whether to re-review. That requires recording the base SHA at
review time, which is one nullable column on `stage_runs`.

---

## 5. Tracking the change request

### 5.1 The contract addition

`RepositoryProvider` (`providers/types.ts:81-119`) gains one method:

```ts
/** Reads back a change request's current state. `null` when the provider has no API. */
readChangeRequest?(
  context: ProviderContext,
  ref: { number: number },
): Promise<ChangeRequestState | null>;

export type ChangeRequestState = {
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  /** Aggregate CI conclusion, or `null` when the provider reports none. */
  checks: "pending" | "success" | "failure" | null;
  /** Aggregate human review state, or `null`. */
  review: "approved" | "changes_requested" | "pending" | null;
  mergeable: boolean | null;
  updatedAt: number;
};
```

Optional, because `genericProvider` has no API at all — the same reason
`createChangeRequest` already has a documented throw-and-fall-back contract
(`providers/types.ts:109-115`).

### 5.2 What each provider can actually report

`spec-multi-provider-repositories.md` §3.3 established the PR API matrix; this
extends it with the read side.

| Provider | State | Checks | Review |
|---|---|---|---|
| GitHub | `GET /repos/:o/:r/pulls/:n` | `GET /commits/:sha/check-runs` | `GET /pulls/:n/reviews` |
| GitLab | `GET /projects/:id/merge_requests/:iid` | `head_pipeline.status` on the same payload | `approvals` (edition-dependent) |
| Bitbucket | `GET /pullrequests/:id` | `GET /commit/:sha/statuses` | participants on the same payload |
| Azure DevOps | `GET /pullrequests/:id` | policy evaluations | reviewers on the same payload |
| Generic | — | — | — |

Two of the five need a second request for checks. The interface therefore
returns one merged object and lets each provider decide how many calls that
takes, rather than exposing three methods and pushing the sequencing into the
worker.

`null` for `checks` and `review` means "this provider does not report it",
which the UI renders as absent rather than pending — the distinction matters,
because a permanently-pending CI chip on GitLab CE would be read as a hung
pipeline.

### 5.3 Polling

A `poll_pr` job kind, enqueued at delivery and re-enqueued by itself with a
backing-off `runAfter` — the mechanism `scheduleWorkspaceCleanup` already uses
for deferred work (`orchestrator.ts:130-134`, `queue.ts:40-58`).

Cadence: every 2 minutes for the first hour, every 15 minutes for the first day,
hourly after that, stopping when the state becomes `merged` or `closed`, or
after 30 days. Polling is not free — it is a network round trip per open PR —
and the value decays fast: the first hour is when CI reports, and after a week
an un-merged PR is a human problem, not a polling problem.

The poll must be skipped entirely when `delivery_outcome === 'manual'`, since
there is no PR number to poll.

### 5.4 A "Delivered" state distinct from "Completed"

`COMPLETED` currently means "the pipeline finished". With §5 it can mean
something stronger, and conflating the two would lose information.

Rather than adding a stage — which would mean a new `Stage`, a new board column
and a new terminal in the state machine — the board renders **sub-state within
the completed column**, driven by `pr_state`:

| `pr_state` | Card chip |
|---|---|
| `NULL`, outcome `manual` | "branch pushed — PR not opened" |
| `open`, checks `failure` | "PR open · CI failing" |
| `open`, review `changes_requested` | "PR open · changes requested" |
| `open` | "PR open" |
| `merged` | "merged" |
| `closed` | "closed without merging" |

This keeps the state machine untouched, which matters: `TERMINAL_STAGES`
(`stages.ts:31-38`) is load-bearing for cancellation, cleanup scheduling and
`taskIsActive` (`queue.ts:162-170`), and adding a non-terminal state after
`COMPLETED` would ripple through all three.

### 5.5 The workspace outlives the PR, briefly

`scheduleWorkspaceCleanup` (`orchestrator.ts:130-134`) queues removal
`workspaceRetentionDays` after the terminal transition — 7 days by default
(`env.ts:152`). Polling can outlive that, which is fine for state but means the
diff is gone (`execute.ts:404-412` nulls `workspacePath`).

That is `spec-audit-trail.md` §6's `diff_summary` artifact's job. This spec
depends on it for §6's reopen path and does not re-specify it. What it *does*
add is that cleanup must be **deferred while the PR is open**: re-scheduling the
cleanup job when a poll finds `state: "open"` costs one row and prevents the
common case — a PR sitting in review for two weeks and its workspace vanishing
under it, so §6 cannot push a fix without a fresh clone.

### 5.6 Merge from the app, but not automatically

A merge button on the task detail page, calling the provider's merge endpoint.
It is a single explicit human action, which is consistent with a product built
around human gates.

Automatic merge on green CI is not offered. The delivery gate already asked a
human to approve *opening* the PR; auto-merging after it would make that
approval mean something the user did not agree to. `README.md`'s "Known limits"
promises merging is always manual — a promise worth keeping rather than
quietly widening.

---

## 6. Reopening from pull-request feedback

### 6.1 The shape of the problem

Red CI, or a reviewer comment on the PR, is exactly the input the Developer
needs — and it arrives after the pipeline has declared itself finished.

Everything needed to act on it exists: the branch is pushed, the workspace is on
disk (§5.5 keeps it there), and `human_review` is an established artifact type
that the Developer already receives on a rework cycle
(`execute.ts:105-110`, `stages.ts:133-134`).

### 6.2 The flow

1. The user presses **"Send back to the Developer"** on a delivered task, or the
   poller offers it when `checks: "failure"` or `review: "changes_requested"`.
2. The provider's review comments and failing check summaries are fetched and
   rendered into a `human_review` artifact — `## Requested Changes` followed by
   the comments, attributed to the PR.
3. `restart_from` with `stage: "DEVELOPMENT"` — the signal
   `spec-human-in-the-loop.md` §5.2 introduces — moves the task out of
   `COMPLETED` and re-admits it under the ordinary capacity check.
4. The pipeline runs `DEVELOPMENT → CODE_REVIEW → QA → …` as usual.
5. At `DELIVERY`, `pushBranch` pushes the **same branch**
   (`workspace.ts:183-201`), which updates the existing PR. `createChangeRequest`
   must therefore be skipped when `pr_number` is already set, or the provider
   will reject a duplicate PR for the same head.

Step 5 is the one that needs new code in `executeDelivery`; the rest is
composition of mechanisms other specs build.

### 6.3 Why not a dedicated stage

A `PR_FEEDBACK` stage was considered and rejected. The work is ordinary
development work driven by ordinary review feedback; the only thing that differs
is where the feedback came from. Modelling it as a distinct stage would duplicate
`DEVELOPMENT`'s role, prompt and artifact for no behavioural difference, and
would need its own entry in every stage-keyed record — `ROLES`, `models`,
`providers`, `maxTurns` (`settings/store.ts:57-92`).

### 6.4 Terminal states are not immutable, and that is fine

This is the first mechanism in the product that leaves a terminal stage. The
guard that keeps it safe is that it goes through the same re-admission as a
fresh start: capacity checked, quota checked (once
`spec-spend-and-operational-control.md` §4 exists), and the job queue's
`taskIsActive` (`queue.ts:162-170`) starts returning true again because the
status is no longer terminal.

The one thing that must not happen is the cleanup job firing mid-rework. It is
already scheduled with a `runAfter` days out; reopening cancels any pending
`cleanup_workspace` job for the task — `cancelPendingJobs` (`queue.ts:134-139`)
does exactly this and is already called on every terminal transition.

---

## 7. Base branch per task, and stacked work

### 7.1 The collision with dependencies

Every task branches from `repo.defaultBranch`: `prepareWorkspace` is called with
`defaultBranch: task.repo.defaultBranch` (`execute.ts:150`) and checks out from
`origin/<that>` (`workspace.ts:115`).

Now consider the dependency feature. Task B depends on task A
(`taskDependencies`, `schema.ts:210-227`), and `assertPrerequisitesMet`
(`orchestrator.ts:228-231`) requires A to reach `COMPLETED`. But `COMPLETED`
means "PR opened" — not merged (§5.4). So B is unblocked and clones from `main`,
which does **not** contain A's work. The dependency was honoured and delivered
nothing.

### 7.2 Two fixes, and only one of them is small

**Small:** a nullable `tasks.base_branch` that overrides `repo.defaultBranch`
for the clone, the diff range and the PR base. Set manually, it lets a user
stack B on A's branch deliberately.

**Correct:** when B depends on A and A's branch is not merged, B's base is A's
branch automatically, and the PR is opened against it — a stacked PR. When A
merges, B's PR retargets to `main`.

The correct version needs merge-state tracking (§5), retargeting support per
provider, and a rule for what happens when A is closed without merging. It is
the largest item in this spec and the least certain (§12.2).

**Ship the small one and make the dependency semantics honest**: until stacked
PRs exist, the dependency gate should offer "wait for merge" as well as "wait
for completion", using §5's `pr_state`. That is a one-line change to
`incompleteDependencies` (`service.ts:275-277`) plus a per-task flag, and it
removes the surprise without building the stack.

---

## 8. The shape of the pull request

### 8.1 What is sent today

```ts
// github.ts:93-98
body: {
  title: input.title,
  body: input.body,
  head: input.headBranch,
  base: input.baseBranch,
}
```

`ChangeRequestInput` (`providers/types.ts:72-77`) carries exactly those four
fields plus the provider context. So: every agent PR is opened
ready-for-review into the whole team's queue, with no reviewers, no labels, and
a title that is the raw task title — which a repository enforcing conventional
commits will reject outright.

`BRANCH_PREFIX = "pipeline"` is a module constant (`workspace.ts:22`), so a team
whose branch protection expects `feature/*` cannot comply.

### 8.2 The additions

`ChangeRequestInput` gains optional fields, and each provider maps what it
supports and ignores the rest:

```ts
draft?: boolean;
reviewers?: string[];
labels?: string[];
```

Configured per repository connection — they are properties of the *destination*,
not of the task — as three nullable columns on `repos`, plus:

- `branch_prefix TEXT` — defaulting to `pipeline` so nothing changes for
  existing connections.
- `pr_title_template TEXT` — e.g. `feat: {title}`, with `{title}` and `{taskId}`
  substitutions. Left NULL, the title is the raw task title, exactly as today.
- `pr_body_template TEXT` — prepended to the generated body
  (`buildPullRequestBody`, `execute.ts:311-339`), so a repository's PR checklist
  survives.

`draft: true` deserves its own note: for a team adopting this product, opening
every agent PR as a draft is probably the correct default, and it is the single
most effective way to keep an autonomous pipeline from becoming a nuisance to
human reviewers. It is not made the default here only because it would change
behaviour for existing installations.

### 8.3 Editing a connection

`src/app/api/repos/[id]/route.ts` exports `GET` (`:8`) and `DELETE` (`:34`).
There is no `PATCH`. A connection is write-once: rotating a token to a
differently-named environment variable, correcting a default branch, or adding
any of §8.2's fields means editing SQLite by hand or deleting and recreating.

And deleting is refused while *any* task references the repo — `deleteRepo`
counts tasks with no status filter (`service.ts:73-83`), so a single finished
task from months ago pins the connection forever.

Two changes:

- **`PATCH /api/repos/:id`**, validated with the same `createRepoSchema` shape,
  re-running `verifyRepositoryAccess` and returning the result the way `POST`
  already does (`repos/route.ts:60-72`). `url` and `provider` are editable only
  when no task has ever used the connection; everything else is always editable,
  because a stored URL is what past workspaces were cloned from and rewriting it
  would make the audit trail lie.
- **"Test connection"** as an explicit button. The backend already exists:
  `GET /api/repos/:id` calls `verifyRepositoryAccess` and returns `verified`,
  `defaultBranch` and `reason` (`repos/[id]/route.ts:15-27`). Only the UI is
  missing.

`deleteRepo`'s refusal stays — a repo row referenced by a task is what makes
that task's history readable — but the error message should say how many tasks
and offer archiving them (`spec-board-at-scale.md` §4) rather than presenting a
dead end.

---

## 9. Data model summary

One appended `MIGRATIONS` entry (`migrations.ts:39-64`), all via `addColumn` so
re-running is harmless:

```ts
{
  name: "delivery outcome, pull request tracking and connection options",
  up: (sqlite) => {
    addColumn(sqlite, "tasks", "delivery_outcome", "TEXT");
    addColumn(sqlite, "tasks", "delivery_reason", "TEXT");
    addColumn(sqlite, "tasks", "pr_number", "INTEGER");
    addColumn(sqlite, "tasks", "pr_state", "TEXT");
    addColumn(sqlite, "tasks", "pr_checks", "TEXT");
    addColumn(sqlite, "tasks", "pr_review", "TEXT");
    addColumn(sqlite, "tasks", "pr_polled_at", "INTEGER");
    addColumn(sqlite, "tasks", "base_branch", "TEXT");
    addColumn(sqlite, "stage_runs", "base_sha", "TEXT");
    addColumn(sqlite, "repos", "branch_prefix", "TEXT");
    addColumn(sqlite, "repos", "pr_draft", "INTEGER NOT NULL DEFAULT 0");
    addColumn(sqlite, "repos", "pr_reviewers", "TEXT");   // JSON array
    addColumn(sqlite, "repos", "pr_labels", "TEXT");      // JSON array
    addColumn(sqlite, "repos", "pr_title_template", "TEXT");
    addColumn(sqlite, "repos", "pr_body_template", "TEXT");
  },
}
```

Every column is nullable or defaulted, so existing rows keep their exact current
behaviour — the compatibility property `spec-multi-provider-repositories.md` §9
established for the `provider` column.

New `JobKind`: `poll_pr`, added to `JOB_KINDS` (`schema.ts:234`) and to the
worker's `handleJob` switch (`worker/index.ts:64-81`). Note that
`handleJobFailure` special-cases `cleanup_workspace` twice (`:112`, `:132`) to
avoid failing a finished task; `poll_pr` needs the same treatment, and the
condition is better expressed as a property of the kind than as a growing list
of literals.

---

## 10. Test plan

**Workspace (temp git repos, no network)**
- A fetch after the base advances changes what `origin/base...HEAD` resolves to;
  the diff index reflects the new base.
- A fetch failure leaves the stage running and appends a stale-base event.
- Rebase applies cleanly when there is no overlap; conflicts abort and leave the
  original branch intact and pushable.
- A base that moved beyond the shallow depth triggers one deepen, then behaves
  as a conflict if still unresolvable.

**Delivery**
- `createChangeRequest` returning `{status:"manual"}` sets `delivery_outcome`
  to `manual`, leaves `pr_number` NULL, and the detail page renders the banner
  rather than the link. **This test fails today.**
- A `created` outcome records `pr_number` from `ChangeRequestRef.id`.
- Re-delivering a task that already has a `pr_number` pushes and does **not**
  call `createChangeRequest`.

**Provider contract (fakes)**
- `readChangeRequest` parameterised over all five providers: the four with APIs
  map state, checks and review; `generic` returns `null` and the poller skips it.
- A provider that omits check reporting yields `checks: null`, and the UI
  renders nothing rather than "pending".

**Polling**
- The job re-enqueues with the specified backoff and stops on `merged`.
- A `manual` delivery never enqueues a poll.
- An open PR defers `cleanup_workspace`.

**Reopen**
- A `COMPLETED` task sent back writes a `human_review` artifact containing the
  PR comments, leaves `COMPLETED`, and passes the capacity check.
- Any pending `cleanup_workspace` job for the task is cancelled.
- The next `DEVELOPMENT` run receives the artifact in its inputs.

**Connections**
- `PATCH /api/repos/:id` updates the editable fields and re-verifies.
- `url`/`provider` edits are refused once a task references the connection.
- The delete refusal names the task count.

---

## 11. Latent bugs this change trips

### 11.1 `pr_url` consumers assume a real PR

`tasks/[id]/page.tsx:105-115` renders the link whenever `task.prUrl` is set.
Once §3 distinguishes the two, every reader of `pr_url` must consult
`delivery_outcome` first. Grepping for `prUrl` before implementing is the
cheapest way to find them all.

### 11.2 The git helpers swallow every error

`diffAgainstBase`, `diffStatAgainstBase` and `hasCommitsAheadOfBase`
(`workspace.ts:126-162`) each wrap their git call in `try { … } catch { return
"" }` or `return false`. That is defensible when a missing ref means "no diff",
and dangerous once a fetch can fail: a network error would silently produce an
empty diff, which QA would then review as "no changes" and, per
`extractReviewVerdict`'s fail-closed rule (`artifacts.ts:187-192`), reject.

These should distinguish "no such ref" from "the command failed". It is a
prerequisite for §4, not a follow-up.

### 11.3 Rebase invalidates the reviewed SHA

§4.5 records `base_sha` at review time to show drift. A rebase at delivery
rewrites the task branch's commits, so any SHA recorded against the old history
no longer resolves. The recorded value must be the **base** SHA, not the head
SHA, which is why the column is named that way — but any future feature that
records head SHAs (incremental review, `spec-agent-context.md` §4) has to handle
the rewrite.

### 11.4 `providerFor` falls back to generic silently

`providerFor` returns `genericProvider` for an unknown id
(`git/providers/index.ts:28-30`), documented as a defence against a stored value
crashing a page. With §5, that fallback means a repo whose provider string is
corrupt would report "this provider has no API" rather than an error — a silent
degradation of tracking. Worth a warning event when the fallback is hit.

---

## 12. Phasing

**Phase A — the manual-delivery banner (§3).** Two columns, one branch in
`executeDelivery`, one component change. It converts a silent lie into a
correct statement and needs nothing else in this spec.

**Phase B — fetch (§4.1-§4.2) and the error-swallowing fix (§11.2).** Small,
and it stops the most common cause of a stale review. Rebase (§4.3-§4.4) can
follow separately.

**Phase C — connection editing and testing (§8.3).** Independent of everything
else and removes the most frequent manual-SQLite task.

**Phase D — PR tracking (§5).** The provider contract addition, the poller, the
board chips. The largest coherent unit here, and the prerequisite for E.

**Phase E — reopen from feedback (§6).** Depends on D for the feedback source
and on `spec-human-in-the-loop.md` §5 for `restart_from`.

**Phase F — PR shape (§8.1-§8.2) and per-task base (§7.2, small version).**
Configuration surface; valuable but never blocking.

Stacked PRs (§7.2, correct version) are deliberately not phased. See §13.2.

---

## 13. Open questions

1. **Should the rebase happen at delivery or continuously?** §4.3 rebases once,
   at delivery, to avoid rewriting history a reviewer may have read. The
   opposite argument is that a task sitting at a gate for two days is exactly
   when a rebase is cheapest, and delaying it means the conflict is discovered at
   the least convenient moment. A middle option — rebase whenever the task is
   *not* at a gate — is more code and possibly the right answer.
2. **Are stacked PRs worth building at all?** §7.2 describes them and this spec
   does not phase them, because a dependency chain of agent-written PRs stacked
   on each other is a lot of machinery for a scenario that may be rare in a
   single-user tool. The "wait for merge" dependency option is the cheap test:
   if users turn it on and complain about the wait, stacking is worth it; if
   they never turn it on, it never was.
3. **Does polling belong in the worker at all?** The worker exists to run agent
   sessions, and a PR poll is an HTTP request that could equally run from the
   web process on a request-triggered basis (poll when someone opens the page).
   That would remove a job kind and a background cadence entirely, at the cost
   of never noticing a merge nobody looked at. Given notifications
   (`spec-spend-and-operational-control.md` §8) are the reason to notice, the
   answer depends on whether "your PR merged" is a notification worth having.
4. **Whose reviewers?** §8.2 stores reviewer handles per connection, which
   assumes the same people review every agent PR in that repository. Per-task
   reviewers would be more flexible and would need a picker fed by the
   provider's collaborator API — a per-provider endpoint each, for a field most
   users would set once.
5. **What should happen when a PR is closed without merging?** §5.4 renders it,
   and nothing acts on it. Arguably the task should return to a non-terminal
   state, since the work was rejected — but "closed" is also how a human says
   "I did this differently", and reopening it automatically would be wrong.
   Probably an offered action, not an automatic one, but it is unresolved.
6. **Draft by default.** §8.2 declines to change the default for existing
   installations. For a *new* connection there is no such constraint, and
   defaulting new connections to draft while leaving existing ones alone is
   inconsistent in a way that is hard to explain in a settings screen.
