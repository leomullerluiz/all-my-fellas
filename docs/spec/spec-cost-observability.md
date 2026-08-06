# Cost Observability — Technical Specification

> **Version:** 0.1 (design proposal — nothing in this document is implemented)
> **Scope:** Make the money numbers correct, then make them answer questions.
> Fixes two live bugs in the usage figures, records which model and provider
> produced each stage run, separates quota by provider, and replaces the
> free-text model field with a tiered picker.
> **Prerequisite:** the pipeline as built. §3 is a prerequisite for
> `spec-cost-forecast.md`, and §4 is a prerequisite for the per-provider half of
> `spec-spend-and-operational-control.md` §4.8.
> **Related:** `spec-cost-forecast.md` (unbuilt in full; §3.1 there measured the
> token bug §2.2 fixes, and §8 requires the segmentation §3 adds);
> `spec-spend-and-operational-control.md` (§4 enforces the quota this spec
> segments; §5.4 fixes the partial-cost loss that makes failed runs read as $0);
> `spec-multi-provider-repositories.md` (§9 — the compatibility pattern §3.3
> follows for backfilling a new column);
> `spec-audit-trail.md` (§3 — the persisted prompt, which is what makes a token
> count auditable rather than merely displayed).

---

## 1. Summary

The Costs screen renders three numbers per stage run — input tokens, output
tokens, dollars — beside each other, in the same typeface, with the same
authority. One of them is wrong by roughly three orders of magnitude, and the
API that serves the same data ignores its own window parameter.

**`GET /api/usage?days=N` filters nothing.** The route computes a millisecond
cutoff and passes it to a function whose parameter is a *day count*:

```ts
// src/app/api/usage/route.ts:15-19
const since = parsed.data.days
  ? Date.now() - parsed.data.days * 24 * 60 * 60 * 1000
  : undefined;
const perTask = costPerTask(since);
```

```ts
// src/server/tasks/service.ts:629-634
export function costPerTask(windowDays?: number): TaskCostSummary[] {
  const since =
    windowDays && Number.isFinite(windowDays)
      ? Date.now() - windowDays * 86_400_000
      : undefined;
```

A timestamp around `1.77e12` multiplied by `86_400_000` gives a cutoff near
`-1.5e20`. Every row passes. The page passes the correct unit
(`usage/page.tsx:22-25`), so the page and the API disagree about what
`days=7` means.

**Input tokens are understated by about 1000×.** The Claude adapter reads one
field:

```ts
// src/server/pipeline/providers/claude.ts:106
inputTokens = message.usage.input_tokens ?? 0;
```

With prompt caching active, `input_tokens` is only the *uncached remainder*;
`cache_read_input_tokens` and `cache_creation_input_tokens` carry the rest and
are discarded. `spec-cost-forecast.md:96` measured it on this installation:
inputs of "11, 21, 35, 97 against outputs of 4k-19k". The dollar figures beside
them are correct — they come from the SDK's own `total_cost_usd`
(`claude.ts:105`) — which is exactly what makes the token counts credible.

**Nothing records what produced a run.** `execute.ts:127-130` resolves the model
and the provider for a stage and puts them into an event payload
(`:133-139`), which is JSON in a log table. `stage_runs` has neither column
(`schema.ts:79-107`). So the product cannot answer "is Opus on the Developer
worth four times Sonnet", "what does this repository cost", or "how much of this
month was Gemini".

**Quota predates multi-provider.** The quota key is the *Claude* auth mode
(`quota.ts:83-87`) and `costSince` sums every stage run regardless of provider
(`service.ts:602-611`). Gemini spend is debited against a Claude subscription,
and an installation with no Claude credential shows "not configured" while
ChatGPT spends real money.

---

## 2. Scope

**In scope**

- The two bugs above, and the `usageByStage` window gap (§2).
- `model` and `provider` columns on `stage_runs`, with backfill (§3).
- Per-provider quota pools (§4).
- A model picker that stores a tier and validates against the provider (§5).
- Weekly and monthly cadence, configurable threshold, and the warning where
  spend is committed (§6).
- CSV export and spend-per-day (§7).

**Out of scope**

- Enforcing any limit. This spec makes the numbers right;
  `spec-spend-and-operational-control.md` §4 and §5 make them act. §8 states
  the dependency in both directions.
- Forecasting. `spec-cost-forecast.md` owns it, and §8 argues it is not honestly
  implementable until §3 lands.
- Recording partial cost on a failed run —
  `spec-spend-and-operational-control.md` §5.4 owns it. Every aggregate in this
  spec is wrong in the same way until it lands, and §2.4 says so.

---

## 3. The two bugs, and one gap

### 3.1 The window unit

Two functions disagree about whether a number is a timestamp or a day count,
and the type system cannot help because both are `number`.

Fix the caller, not the callee: `costPerTask(windowDays)` is the better API —
the comment at `service.ts:626-628` explains why the cutoff is computed inside
(so React components need not read the clock during render), and that reasoning
still holds. The route passes `parsed.data.days` directly.

To stop it recurring, the parameter becomes explicit at the call site by name:

```ts
const perTask = costPerTask(parsed.data.days);
```

A branded type (`type Days = number & { __brand: "days" }`) was considered and
rejected as heavier than the defect warrants for a single call site — but the
test in §9 pins the behaviour so a future refactor cannot silently reintroduce
it.

### 3.2 Cached input tokens

```ts
const usage = message.usage;
inputTokens =
  (usage.input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0);
```

Two consequences worth stating rather than discovering:

- **Historical rows stay wrong.** There is no way to recover what was not
  recorded. `/usage` should not pretend otherwise: the by-task table marks rows
  written before the fix, using the schema version or a cutoff timestamp, as
  "tokens under-reported". Silently mixing corrected and uncorrected rows in one
  total is a worse number than either.
- **The cache hit rate becomes visible, and is worth showing.** Once the three
  components are known, `cache_read / total_input` is the single most useful
  efficiency figure the product can display, because it is the mechanism that
  makes a seven-stage pipeline affordable. Store the components, not just the
  sum:

```ts
addColumn(sqlite, "stage_runs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
addColumn(sqlite, "stage_runs", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0");
```

`input_tokens` then holds the total, so every existing consumer
(`usageByStage`, `costPerTask`, the timeline at `tasks/[id]/page.tsx:155`)
keeps working and simply becomes correct.

OpenAI and Gemini report a single prompt-token count
(`openai.ts:102`, `gemini.ts:106`) with no cache breakdown, so the two new
columns stay zero there. That is accurate, not missing: their cost is computed
from the flat table in `pricing.ts:17-30` and has no cached tier.

### 3.3 `usageByStage` takes no window

`usageByStage(taskId?)` (`service.ts:572-585`) accepts a task filter and no time
filter, which is why the Costs page renders a card titled "By stage (all time)"
(`usage/page.tsx:67`) directly underneath a 7/30/90-day selector. The selector
changes one card and not the other, with no explanation.

Add the same optional window, and remove the parenthetical from the title.

### 3.4 Every aggregate is low until the partial-cost fix

`markStageRunStatus(stageRunId, "failed", { error })` (`execute.ts:217`,
`:243`, `:285`, `:388`) never writes tokens or cost, so a stage that burned five
dollars before failing records zero.

That is `spec-spend-and-operational-control.md` §5.4's fix, and it is a
prerequisite for trusting anything on the Costs screen. It is named here because
a reader of this spec will otherwise reasonably assume §3.1 and §3.2 make the
numbers right, and they do not — they make the *successful* numbers right.

---

## 4. Recording what produced a run

### 4.1 Two columns

```ts
addColumn(sqlite, "stage_runs", "model", "TEXT");
addColumn(sqlite, "stage_runs", "provider", "TEXT");
```

Written in `executeAgentStage`, where both are already resolved:

```ts
// execute.ts:127-130
const model = settings.models[run.stage];
const provider = settings.providers[run.stage];
```

They are read from settings at execution time and are therefore *not* derivable
after the fact — a user who changes a model in Settings makes every historical
run's provenance unknowable. That is the argument for the columns: they record a
decision that no longer exists anywhere else.

### 4.2 Nullable, not backfilled

Both columns are nullable and existing rows keep NULL. A backfill would have to
guess from current settings, which is precisely the wrong answer — the setting
may have changed, and a fabricated provenance is worse than an absent one.

Aggregates group NULL as "unknown", rendered as such. This is the same
compatibility posture `spec-multi-provider-repositories.md` §9 took for
`repos.provider`, except that column could honestly default to `github` because
every pre-existing row genuinely was GitHub. Here no such honest default exists.

### 4.3 What the columns unlock

Three things, none of which are possible today:

- **Cost by model and by provider.** A `GROUP BY provider, model` over
  `stage_runs`, which is what makes "is Opus on the Developer worth it" a query
  rather than an argument.
- **Per-provider quota** (§5), which needs `WHERE provider = ?` on `costSince`.
- **Honest forecasting.** `spec-cost-forecast.md` §4.2 builds per-stage
  baselines from history. A baseline that mixes Haiku and Opus runs of the same
  stage is not a baseline; it is an average of two distributions.

### 4.4 Cost per repository

`stage_runs` joins to `tasks` (`schema.ts:83-85`), which joins to `repos`
(`:49-51`), so cost per repository is available the moment anyone writes the
query — no schema change needed. It is listed here because it is the question
users ask second, after "what did this task cost", and the answer already exists
in the data.

---

## 5. Per-provider quota

### 5.1 The model that no longer fits

`resolveQuotaStatus` (`quota.ts:82-103`) does three things in sequence: reads
the Claude auth mode, looks up `quotaLimits[mode]`, and compares it against
`costSince(periodStart(...))`. The type is
`QuotaConfig = Record<"subscription" | "api_key", QuotaLimit>` (`env.ts:169`) —
the two *Claude* auth modes.

When that was written, Claude was the only backend. Now `LLM_PROVIDER_IDS` has
three members (`config/llm-providers.ts:10`) and each is selectable per role.
The consequences today:

- Gemini and OpenAI spend counts against the Claude limit, because `costSince`
  sums everything.
- With no Claude credential, `resolveProviderAuth()` returns `mode: "missing"`
  and the bar reports `not_configured` (`quota.ts:84`) — while ChatGPT spends.

### 5.2 The shape

Keyed by provider, with the Claude entry keyed additionally by auth mode
because that distinction is real for Claude and meaningless for the other two:

```ts
export type QuotaKey =
  | { provider: "claude"; mode: "subscription" | "api_key" }
  | { provider: "chatgpt" }
  | { provider: "gemini" };
```

`resolveQuotaStatus` returns one status per configured provider, and the usage
bar renders one row per configured provider rather than a single figure. A
provider with no limit set is absent from the bar, not shown as zero — the
`not_configured` distinction `quota.ts:75-81` already makes, applied per
provider.

`costSince` gains a provider filter, which is only possible once §4's column
exists. Rows with NULL provider are attributed to Claude for continuity with
the pre-multi-provider period, and the bar says so on hover.

### 5.3 The estimate warning has to be per provider

Claude's cost is Anthropic's own `total_cost_usd` (`claude.ts:105`); in
subscription mode it is an estimate of equivalent API spend rather than a bill.
OpenAI and Gemini costs come from a hand-maintained table
(`pricing.ts:17-30`) that "WILL drift" by its own comment, and an unrecognised
model id reports **$0** (`pricing.ts:34-35`).

That last behaviour is the dangerous one: a user who types a model id not in the
table gets a working pipeline that reports zero spend forever. §6.2 makes that
impossible for new configurations; until then, the bar must show a warning
whenever any stage ran on a provider whose model is not in `PRICING`.

---

## 6. The model picker

### 6.1 A free-text field that fails at runtime

Model ids are typed into a text input per stage (`settings-form.tsx:131-138`),
with no validation against the selected provider.
`docs/llm-providers.md:106-107` records the consequence: switching a role's
provider without updating its model id "sends an incompatible model string to
the new provider and fails at *run* time" — which is after every earlier stage
of that task has already been paid for.

### 6.2 Store the tier, not the literal

`resolveModels` (`env.ts:131-137`) already defines three tiers — `MODEL_LIGHT`,
`MODEL_DEFAULT`, `MODEL_HEAVY` — and `defaultSettings` maps each stage to one of
them (`settings/store.ts:58-66`). Then the settings blob stores the resolved
*literal*, so the tier is lost the moment a user saves.

`MODEL_HEAVY` is the proof: it is read by `resolveModels`, documented in
`.env.example` and the README, and referenced by **no role**. It is dead
configuration precisely because tiers are not a first-class concept past
`defaultSettings`.

Store the tier:

```ts
models: Record<AgentStage, { tier: "light" | "default" | "heavy" } | { literal: string }>;
```

A tier resolves per provider at execution time, from a table that also gives the
picker its options:

```ts
const TIER_MODELS: Record<LlmProviderId, Record<Tier, string>> = {
  claude:  { light: "claude-haiku-4-5", default: "claude-sonnet-5", heavy: "claude-opus-5" },
  chatgpt: { light: "gpt-4.1-mini",     default: "gpt-4.1",        heavy: "o3" },
  gemini:  { light: "gemini-2.5-flash", default: "gemini-2.5-pro",  heavy: "gemini-2.5-pro" },
};
```

Switching a role's provider then keeps working, which is the runtime failure
`docs/llm-providers.md` documents, removed rather than described.

The `{ literal }` escape hatch stays: a new model appears before this table is
updated, and forcing a release to use it would be worse. A literal is validated
against `PRICING` for the two providers whose cost depends on it, and warns
loudly when absent (§5.3).

### 6.3 Show the price beside the choice

The picker renders the per-million input and output price from `PRICING` for
OpenAI and Gemini. Claude has no such table — its cost comes from the SDK — so
its rows show the tier name and no price, with a note saying why.

That asymmetry is honest and worth preserving: inventing a Claude price table
would create a fourth number that drifts, in a spec whose entire purpose is
that the numbers should be trustworthy.

---

## 7. Cadence, threshold, and where the warning goes

### 7.1 Nobody budgets an LLM by the hour

`Cadence` is `"daily" | "hourly"` (`env.ts:157`). Hourly exists for rate-limit
windows; nobody plans spend that way. `weekly` and `monthly` are the units users
actually think in, and `periodStart`/`nextReset` (`quota.ts:28-47`) extend to
them naturally — both already operate on the local calendar via
`setHours`/`setDate`, and the comment at `:20-27` is explicit that local time is
the requirement, not an accident.

Monthly needs `setDate(1)` and `setMonth(+1)`; weekly needs a week-start
convention, which is a setting in itself (§10.4).

### 7.2 The threshold is a module constant

`WARNING_RATIO = 0.8` (`quota.ts:61`). It becomes a setting. One line, and it is
the difference between a warning that is useful and one that arrives too late
for a user whose tasks cost 30% of their limit each.

### 7.3 The warning is in the wrong place

The quota state is computed on the dashboard and rendered at the bottom of it
(`page.tsx:95`, `:156`). The moment a user commits *new* spend is the new-task
form and the Start button — neither of which shows it.

The usage bar's data moves into a small shared component rendered on the
new-task form and beside every Start affordance when the state is `warning` or
`exceeded`. This is the cheapest item in the spec and probably the highest
value per line: it puts the number in front of the decision that changes it.

---

## 8. Export and spend over time

### 8.1 CSV, one stage run per row

The Costs page aggregates by stage and by task
(`usage/page.tsx:24-25`). Neither is the grain someone needs to bill a client or
reconcile against a provider invoice. One row per stage run, with:

```
task_id, task_title, repo, stage, attempt, provider, model,
started_at, finished_at, input_tokens, cache_read_tokens,
cache_write_tokens, output_tokens, cost_usd, status
```

`provider` and `model` come from §4; without them the export is not worth
building, which is the ordering argument for §4 preceding this.

### 8.2 Spend per day

A daily series over the selected window, rendered as a small bar chart above the
existing tables. `costSince` already computes a single cutoff
(`service.ts:602-611`); a `GROUP BY date(started_at/1000, 'unixepoch', 'localtime')`
gives the series in one query.

The local-time modifier matters and mirrors `quota.ts`'s deliberate choice of
local midnight (`:20-27`). A chart bucketed by UTC beside a quota bar reset at
local midnight would disagree by up to a day at the boundary.

---

## 9. Data model summary

One appended `MIGRATIONS` entry (`migrations.ts:39-64`), all `addColumn` so
re-running is harmless:

```ts
{
  name: "stage run provenance and cache token accounting",
  up: (sqlite) => {
    addColumn(sqlite, "stage_runs", "model", "TEXT");
    addColumn(sqlite, "stage_runs", "provider", "TEXT");
    addColumn(sqlite, "stage_runs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn(sqlite, "stage_runs", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0");
  },
}
```

No new tables. Settings blob changes (merged against defaults,
`settings/store.ts:113-126`):

- `models` changes shape from `Record<AgentStage, string>` to the tier union
  (§6.2). This is the one **breaking** blob change in the spec: a stored blob
  holds literals. The merge at `settings/store.ts:116` would produce a
  half-migrated map, so `getSettings` needs a normaliser that reads a bare
  string as `{ literal }`. That keeps every existing installation working and
  lets a user opt into tiers by re-picking.
- `quotaLimits` re-keys from auth mode to `QuotaKey` (§5.2), with the same
  read-time normalisation: an old `{ subscription, api_key }` blob maps to the
  Claude entries.
- `warningRatio: number` (default `0.8`).
- `Cadence` gains `"weekly" | "monthly"`, and `weekStartsOn` if weekly ships.

`updateSettingsSchema` (`validation/schemas.ts:168-178`) must be updated for all
of these. It currently declares `qaMaxCycles`, which is not a member of
`AppSettings`, and does **not** declare `reworkMaxCycles` or
`humanCodeReviewDefault`, which are — so those two fields are silently stripped
by `z.object` on every save today. Fix that in the same change, or the new
fields join them.

---

## 10. Test plan

**The two bugs (regression first)**
- `GET /api/usage?days=7` excludes a task created 30 days ago. **This test fails
  today** and is the whole point of §3.1.
- The API and the page return the same task set for the same `days`.
- `usageByStage` with a window excludes runs outside it, and without one behaves
  exactly as today.
- A Claude result message carrying `input_tokens: 11`,
  `cache_read_input_tokens: 40_000`, `cache_creation_input_tokens: 2_000`
  records `input_tokens: 42_011`, `cache_read_tokens: 40_000`,
  `cache_write_tokens: 2_000`. **This test fails today.**
- OpenAI and Gemini results record zero in both cache columns and the correct
  total.

**Provenance**
- A completed stage run records the model and provider that were in effect,
  parameterised over all three providers.
- Changing the setting afterwards does not change the recorded values.
- Aggregates group NULL provenance as "unknown" rather than omitting the rows.

**Quota**
- With limits set for two providers, spend on one does not consume the other's.
- A NULL-provider historical row counts against Claude.
- No Claude credential plus a ChatGPT limit yields a usage bar, where today it
  yields `not_configured`.
- `periodStart`/`nextReset` for `weekly` and `monthly` land on local boundaries,
  parameterised across a DST transition and a month with 28, 30 and 31 days.
- `warningRatio` from settings changes the state boundary.

**Model picker**
- A tier resolves to the right literal per provider.
- Switching a role's provider with a tier selected keeps the role runnable.
- A `{ literal }` not present in `PRICING` produces a warning for OpenAI and
  Gemini and no warning for Claude.
- `getSettings` normalises a legacy blob of bare model strings into `{ literal }`
  without losing a stage.

**Export**
- The CSV has one row per stage run including failed and cancelled ones.
- Fields containing commas or quotes are escaped.

---

## 11. Phasing

**Phase A — the two bugs (§3.1, §3.2) and the `usageByStage` window (§3.3).**
Small, self-contained, and they make an existing screen stop lying. Nothing else
here is worth building on top of numbers that are wrong.

**Phase B — provenance columns (§4).** Two nullable columns and two assignments.
It unlocks §5, §8.1 and `spec-cost-forecast.md`, and every day it is not shipped
is a day of history that cannot be segmented retroactively. That last point is
the argument for doing it early even though nothing consumes it yet.

**Phase C — the warning where spend is committed (§7.3) and the configurable
threshold (§7.2).** A component move and one setting.

**Phase D — per-provider quota (§5).** Depends on B. Also the point at which
`spec-spend-and-operational-control.md` §4.8's stated limitation can be lifted.

**Phase E — the model picker (§6).** The settings-shape change and its
normaliser, which is the riskiest edit in this spec and benefits from landing
alone.

**Phase F — export and the daily series (§8).** Additive, depends on B for the
columns worth exporting.

---

## 12. Open questions

1. **Should historical rows be marked as under-reporting, or left alone?** §3.2
   marks them. The alternative — say nothing and let the totals be quietly
   inconsistent — is worse, but marking requires a cutoff to compare against,
   and the honest cutoff is "the deploy that fixed it", which the database does
   not know. `PRAGMA user_version` at the time of the run is not recorded
   either. A `schema_version` column on `stage_runs` would solve it and is
   arguably over-engineering for a one-time correction.
2. **Is `MODEL_HEAVY` worth resurrecting at all?** §6.2 makes it selectable, but
   nothing has ever used it, and `spec-code-review.md` §15.3 already asked
   whether `CODE_REVIEW` should default to it and left the answer to
   measurement. If the answer turns out to be no for every stage, the tier
   system carries a rung nobody stands on.
3. **Weekly cadence needs a week-start convention.** Monday in most of the
   world, Sunday in some. It is a real setting with real ambiguity, and it may
   be better to ship `monthly` only and skip `weekly` entirely — monthly is what
   an API bill uses.
4. **Does per-provider quota need per-provider cadence?** §5.2 keys the limit by
   provider but says nothing about whether each may reset on its own schedule.
   A Claude subscription resets on a rolling window Anthropic controls; an
   OpenAI bill is monthly. Forcing one cadence across providers is simpler and
   probably wrong; allowing three is a matrix in a settings screen.
5. **Should the cost of a cancelled or budget-stopped run count against quota?**
   It was real spend, so yes on the arithmetic. But it makes an aborted task
   consume budget twice — once when it ran, once when it is retried — which will
   feel punitive to a user who cancelled precisely to save money. The arithmetic
   should win, and the UI should show cancelled spend as its own line so it is
   at least visible.
6. **A hand-maintained price table is a maintenance liability.**
   `pricing.ts:12` admits prices are "current as of this file's last edit", and
   an unknown model silently reports $0 (`:34-35`). §5.3 warns about the $0 case,
   which is the acute problem. The chronic one — a table that drifts as
   providers reprice — has no good answer in a local-first app with no
   phone-home, and the honest options are to show the table's edit date beside
   every non-Claude figure, or to stop reporting dollars for those providers
   entirely and show tokens only.
