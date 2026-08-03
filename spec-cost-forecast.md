# Per-Task Cost Forecast — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Predict, in dollars, what a task will cost before and during
> execution; compare the prediction against the actual afterwards.
> **Prerequisite:** the pipeline described in `spec-esteira-multiagente.md`, as built.
> **Related:** `spec-task-queue.md` (the forecast belongs on the Created card),
> `spec-code-review.md` (a new stage changes the sum).

---

## 1. Summary

The pipeline already records what every stage actually cost — `stage_runs`
carries `cost_usd` from the Agent SDK's own `total_cost_usd`. What it cannot do
is tell you, *before* you start, what a task is going to cost.

This adds a forecast at three moments, with honestly different confidence:

| Moment | Known | Confidence |
|---|---|---|
| Before start (Created card, new-task form) | repo, description, priority, configured models | **Low** |
| At `PLAN_GATE` | + difficulty, criticality, affected files | **Good** — this is the decision point that matters |
| In flight | + what has already been spent | Highest for the remainder |

Two design decisions carry most of the weight:

1. **The forecast is a range, not a number.** The dominant variable is not how
   big the task is — it is **how many rework cycles it takes** (§4.3). A point
   estimate hides exactly the thing the user needs to plan for.
2. **The forecast is built from this installation's own history**, not from a
   shipped price model. `cost_usd` is already measured per stage, per model, per
   repository. A seeded prior covers the cold start and then gets out of the way.

---

## 2. What "cost" means here — read this first

`total_cost_usd` from the Agent SDK is **equivalent API spend**. In subscription
mode (`CLAUDE_CODE_OAUTH_TOKEN`, the default) no such amount is billed — the
consumption comes out of the Pro/Max quota. The number is still the right one to
forecast, because it is the only comparable measure of how much work a task
takes, but the UI must never imply money is leaving an account.

**Required labelling.** In subscription mode every forecast and every actual is
prefixed *"est. API equivalent"*, with a tooltip explaining it. In API-key mode
the same figures are real spend and are labelled plainly.

`resolveProviderAuth().mode` already distinguishes the two, so this is a display
concern, not a modelling one.

---

## 3. Baseline: what the data actually looks like

Measured from this installation, **two completed pipelines, 13 successful stage
runs, US$ 4.18 total**. This is not a statistical baseline — it is an order of
magnitude and, more usefully, a **shape**:

| Stage | Run A | Run B | Share of total |
|---|---:|---:|---:|
| Stakeholder | $0.018 | $0.011 | 0.7% |
| Product Owner | $0.198 | $0.303 | 12.0% |
| Architect | $0.456 | $0.218 | 16.1% |
| **Developer** | **$1.239** | **$0.603** | **44.1%** |
| **QA** | **$0.758** | **$0.286** | **25.0%** |
| Homologation | $0.062 | $0.027 | 2.1% |
| Delivery | $0 | $0 | 0% |
| **Task total** | **$2.73** | **$1.45** | |

Three things follow, and they drive the whole design:

**Developer + QA are 69% of the cost.** Every rework cycle re-runs both. That is
why §4.3 treats the cycle count as the primary variable rather than a correction
term.

**Two runs of the same pipeline differed by 1.9×.** With n=2 that is not a
distribution, but it is a strong hint that a single number would be misleading
even for identical configuration.

**Delivery is free.** It is git and an HTTP call. The forecast must sum only
agent stages, not every stage.

### 3.1 A data problem to fix first

The `input_tokens` column is wrong — or rather, it records something other than
what it appears to. Observed values are `11`, `21`, `35`, `97` against outputs of
4k–19k tokens.

`usage.input_tokens` from the SDK is the **uncached remainder only**. The real
prompt volume sits in `cache_read_input_tokens` and `cache_creation_input_tokens`,
which `run-stage.ts` discards. Total prompt tokens =
`input + cache_creation + cache_read`.

Consequences:

- The `/usage` page currently reports input token counts that are off by orders
  of magnitude. That is a live reporting bug, independent of this feature.
- **Any estimator built on the stored token counts would be modelling the wrong
  quantity.**

`cost_usd` is unaffected — the SDK computes it from the full breakdown, which is
why the dollar figures above are trustworthy while the token figures are not.

**Therefore: forecast on cost, not on tokens.** And separately, as a prerequisite:

```sql
ALTER TABLE stage_runs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stage_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
```

populated from `message.usage` in `run-stage.ts`, with `/usage` showing total
prompt tokens rather than the uncached remainder.

---

## 4. The estimation model

### 4.1 Which stages will run

The forecast sums the agent stages a task will actually execute, which depends
on its configuration:

```ts
function plannedAgentStages(task): AgentStage[]
```

- Always: Stakeholder, PO, Architect, Developer, QA, Homologation.
- `CODE_REVIEW` when `spec-code-review.md` lands (unconditional there).
- Gates and Delivery contribute **$0** — they are human decisions and git.
- The plan gate being auto-approved changes nothing in cost.

This must be derived from the same stage list the state machine uses, not a
second hardcoded copy, or the two will drift the first time a stage is added.

### 4.2 Per-stage baseline

For each planned stage, estimate a per-run cost from history, with a
**hierarchical fallback** that trades specificity for sample size:

| Level | Segment | Used when |
|---|---|---|
| 1 | stage + model + repository + difficulty | ≥ 5 samples |
| 2 | stage + model + difficulty | ≥ 5 samples |
| 3 | stage + model | ≥ 3 samples |
| 4 | shipped prior (§4.5) | otherwise |

Each level reports which one it used, so the UI can say *"based on 7 previous
Developer runs on this repository"* rather than presenting an unexplained number.

**Only `status = 'done'` runs count.** A stage that died at turn two cost almost
nothing and would drag the median down. Failed and cancelled runs are excluded
from the baseline — though they still appear in `/usage`, because they were
really spent.

**Attempt 1 and rework runs are kept separate.** A rework Developer run receives
a QA report and a larger diff; its cost profile is not the same. The clean-run
baseline uses `attempt = 1`; the rework increment is measured from `attempt > 1`.

**Statistic: median, not mean.** With a long tail — one Developer run here took
85 minutes — the mean is dragged by outliers that are exactly the cases you do
not want dominating a typical-case estimate. Report p50 for typical and p90 for
the upper end of the likely range.

### 4.3 Rework is the primary variable

Given `reworkCost` = Σ(Developer, Code Review, QA) — the stages a cycle re-runs
— and `cleanCost` = Σ(all planned stages, attempt 1):

```
p50      = cleanCost                                   (no rework)
p90      = cleanCost + reworkCost × expectedCycles     (see below)
ceiling  = cleanCost + reworkCost × reworkMaxCycles    (budget exhausted)
```

`expectedCycles` comes from the installation's own history: the observed rate at
which QA and Code Review return work, over the last N tasks. With no history,
the prior assumes **0.5 cycles** — i.e. every other task needs one rework.

Using the measured shape from §3, where rework stages are 69% of a clean run:

| | Multiplier | On a $2.09 clean run |
|---|---|---|
| p50, no rework | 1.00× | $2.09 |
| p90, one cycle | 1.69× | $3.53 |
| Ceiling, two cycles | 2.38× | $4.97 |

**The spread between p50 and ceiling is ~2.4×.** Presenting only the midpoint
would make the ceiling look like a failure of the estimator rather than a normal
outcome, which is the whole argument for showing a range.

### 4.4 Difficulty is unknown until stage 3

`tasks.difficulty` is set by the Architect — the third agent stage, roughly 29%
of the way through the spend. A task that has not started has `difficulty = NULL`,
so the level-1 and level-2 segments in §4.2 are unavailable and the pre-start
forecast necessarily falls back to level 3.

This is not a defect to engineer around; it is the reason for the two-moment
design in §1. The pre-start number answers *"is this roughly a $2 task or a $20
task?"*. The `PLAN_GATE` number answers *"should I approve this specific plan?"*
— and by then the Architect has stated the difficulty, the criticality and the
list of affected files.

**The `PLAN_GATE` refresh is the highest-value part of this feature.** It sits at
an existing decision point, with real information, in front of a human who is
already being asked to decide.

### 4.5 Cold start

Ship a prior table of per-stage USD, keyed by stage, measured with the default
model tiers. The values in §3 are a reasonable seed.

Rules:

- The prior is **clearly labelled as a default** in the UI — *"rough default;
  will calibrate against your history"* — with the sample count shown as 0.
- History replaces it per segment as soon as the thresholds in §4.2 are met.
  A task can legitimately have some stages priced from history and others from
  the prior.
- If a stage's configured model differs from the reference model, scale by the
  ratio of output prices from a small table. This is approximate — cache
  dynamics do not scale linearly — and it stops mattering as soon as real
  history exists. **The price table is the only place prices are hardcoded**,
  and it needs a comment saying so plus a link to the pricing page.

---

## 5. Data model

```sql
CREATE TABLE task_estimates (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  basis         TEXT NOT NULL,   -- 'pre_start' | 'post_architecture' | 'in_flight'
  p50_usd       REAL NOT NULL,
  p90_usd       REAL NOT NULL,
  ceiling_usd   REAL NOT NULL,
  sample_size   INTEGER NOT NULL,   -- historical runs behind it; 0 = pure prior
  confidence    TEXT NOT NULL,      -- 'prior' | 'low' | 'medium' | 'high'
  assumptions   TEXT NOT NULL,      -- JSON: models per stage, rework budget, difficulty, segment level used
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX task_estimates_task_idx ON task_estimates(task_id, created_at);
```

A **table rather than columns on `tasks`**, because a task gets several estimates
over its life and the interesting product is the sequence: what we thought before
starting, what we thought after the plan, and what it actually cost.

`assumptions` is what makes an old estimate explainable after the user changes
models in Settings. Without it, a stored number is uninterpretable six weeks
later.

No new table for the baseline itself. It is a `GROUP BY` over `stage_runs`, and
for a local single-user app with hundreds of runs that is a sub-millisecond
query. Materialise only if it ever shows up in a profile.

---

## 6. API

| Route | Purpose |
|---|---|
| `POST /api/estimates/preview` | Forecast for a task that does not exist yet — feeds the new-task form. Body: `{ repoId, priority, requireHumanCodeReview }` |
| `GET /api/tasks/:id/estimate` | Current estimate for a task, recomputed against present Settings, plus the stored history of previous estimates |
| `GET /api/usage/calibration` | Estimate-vs-actual for completed tasks (§8) |

The board does not call an endpoint per card — `GET /api/tasks` gains an
`estimate` field on each row, computed in the same request, so N cards do not
mean N round trips.

**Estimates are recomputed on read, not served from the table.** The stored rows
exist for the calibration history; the live number must reflect the models
configured *now*. A user who switches the Developer to a cheaper model and sees
a stale forecast will not trust the feature again.

---

## 7. Where it appears

**New task form** — a live figure that updates as the repository is chosen,
before the task exists. This is where the estimate can actually change a
decision: split the task, or reword it.

**Created card** (per `spec-task-queue.md`) — the range on the card, so the
backlog can be triaged by cost. This is the pairing that makes both features
better: a queue you can order by "what will this cost me" is more useful than
one ordered by title.

**`PLAN_GATE` panel** — the refreshed, higher-confidence estimate directly above
the Approve button, with the delta from the pre-start figure when it moved
significantly (*"was $2.10, now $6.80 — the Architect rated this L / high"*).
A forecast that triples after the plan is exactly the signal a plan gate exists
to surface.

**Task detail, in flight** — spent so far against the forecast, as a bar. Once
past the halfway point the remainder estimate is worth more than the original.

**`/usage`** — the calibration view (§8).

Formatting reuses `formatCost`, which already switches to four decimals below a
cent. Ranges render as `$2.09 – $4.97`, not `$3.53 ± $1.44`; the asymmetric
reality is the point.

---

## 8. Calibration — what makes the number trustworthy

Storing estimates is only worth it if the error is shown back.

For every completed task, compute `actual / p50`. Surface on `/usage`:

- The last N tasks as a small table: estimated range, actual, error.
- A single headline: *"forecasts have been within their range for 8 of the last
  10 tasks"*.
- Per-stage bias, so a systematic miss is attributable: *"Developer runs cost
  1.4× the forecast on this repository"*.

This is also the honest place to admit when the model is not working. If the
range covers the actual less than ~70% of the time, the UI should say the
forecast is not yet reliable rather than continuing to present it with the same
confidence.

**Calibration data comes free** — the estimate is stored, the actual is already
in `stage_runs`. No extra instrumentation.

---

## 9. Making the forecast actionable: budget caps

A forecast the user cannot act on is decoration. The Agent SDK supports a
per-query dollar cap natively:

```ts
// @anthropic-ai/claude-agent-sdk — Options
/** Maximum budget in USD for the query. The query will stop if this budget is
 *  exceeded, returning an `error_max_budget_usd` result. */
maxBudgetUsd?: number;
```

and `SDKResultError.subtype` includes `'error_max_budget_usd'`. Enforcement is
therefore a parameter, not a mechanism to build.

Proposal, as a later phase:

- `tasks.max_budget_usd`, optional, set at creation — pre-filled from the
  forecast's ceiling with a margin, and editable.
- The per-stage share is passed as `maxBudgetUsd` on that stage's `query()`.
- `run-stage.ts` already throws on any non-`success` subtype; it gains a
  specific message for `error_max_budget_usd` so the user sees *"stopped at the
  $5.00 budget cap"* rather than a generic stage failure.
- A `budget_exceeded` event, and a task failure reason that says how to raise
  the cap.

The one design question is whether the cap is per stage or per task. Per stage
is what the SDK gives directly; per task needs the worker to divide the
remaining budget across the remaining stages, which is better behaviour and a
small amount of arithmetic. **Per task, allocated per stage** is the
recommendation — a single Developer run consuming the whole task budget is the
case worth catching.

---

## 10. Limitations to state in the UI, not bury

- **It is a forecast built on your own history.** Two similar tasks differed by
  1.9× here. The range is wide because the underlying variance is.
- **Before the Architect runs, the estimate does not know how hard the task is.**
  Expect it to move at the plan gate.
- **A repository the pipeline has never touched has no history**, and repository
  size drives exploration cost. The first few tasks on a new repo will be the
  least accurate.
- **Subscription mode is not billing** (§2).
- **Changing models in Settings invalidates the historical baseline for that
  stage** until new runs accumulate. The UI should note when a stage's estimate
  is based on runs from a different model.

---

## 11. Test plan

**Unit — baseline**
- Hierarchical fallback selects the most specific segment meeting its threshold,
  and reports which level it used.
- Failed and cancelled runs are excluded; `attempt = 1` and `attempt > 1` are
  separated.
- p50/p90 computed from a known distribution match hand-calculated values.
- Zero history → prior, `sample_size = 0`, `confidence = 'prior'`.

**Unit — composition**
- `plannedAgentStages` reflects `requireHumanCodeReview` and the presence of
  `CODE_REVIEW`; gates and Delivery contribute $0.
- `ceiling` uses `reworkMaxCycles` from current Settings, not a constant.
- Changing a stage's model in Settings changes the recomputed estimate.

**Unit — cache token fix (§3.1)**
- `run-stage.ts` persists all four token counts; `/usage` reports
  `input + cache_creation + cache_read` as prompt tokens.

**Integration**
- A task carries estimates at `pre_start` and `post_architecture`, both stored,
  and the second differs when the Architect sets a difficulty the baseline knows.
- On completion, calibration reports the actual against the stored range.

**Budget cap (phase D)**
- A stage given a tiny `maxBudgetUsd` returns `error_max_budget_usd` and
  produces the specific error message, not the generic one.

---

## 12. Phasing

**Phase A — fix the token accounting (§3.1).** Standalone bug fix. `/usage`
stops lying about input tokens, and the data needed later is captured from then
on. Nothing else depends on it for *cost*, but it should not wait.

**Phase B — baseline and the pre-start estimate.** The aggregation query, the
prior, the preview endpoint, the figure on the new-task form and the Created
card. This is the smallest thing that answers "what will this cost me".

**Phase C — the `PLAN_GATE` refresh and calibration.** The higher-confidence
estimate at the decision point, the stored history, and the estimate-vs-actual
view. Phase B without Phase C produces a number nobody has reason to believe.

**Phase D — budget caps.** Depends on the forecast being trusted, which depends
on C.

---

## 13. Open questions

1. **Should the forecast include a time estimate?** `stage_runs` already has
   `started_at`/`finished_at`, so wall-clock duration is free to model with the
   same machinery. The observed spread is larger than for cost — one Developer
   run took 85 minutes against another at 8 — but "this will take about an hour"
   may matter more day to day than the dollar figure.
2. **Should the pre-start estimate use the description length as a signal?**
   Cheap to add as a feature, plausibly correlated, and easy to fool. Probably
   not worth it against segmenting by repository, which is a stronger signal.
3. **Repository size as a segment.** File count or LOC at clone time would
   explain much of the between-repo variance in exploration cost, but it needs
   the repo cloned — which has not happened at pre-start time. Could be captured
   on the first task per repo and reused.
4. **What should the default `max_budget_usd` be** when budget caps land — the
   ceiling, the ceiling plus a margin, or unset? Unset is the safe default for a
   feature that can kill a run mid-Developer-stage.
5. **Should a forecast above a threshold require confirmation before start?**
   A $50 estimate on a task the user thought was small is worth an interstitial.
   This pairs naturally with the admission control in `spec-task-queue.md` §8.
