# LLM providers

Every agent stage — Stakeholder through PO Homologation — runs against one of
three LLM backends: **Claude** (Anthropic), **ChatGPT** (OpenAI), or **Gemini**
(Google). The provider is chosen per role from **Settings**, alongside the
model id for that role.

**Claude is the default and requires no configuration change.** A fresh
install, and every existing install upgrading into this feature, has every
stage set to `claude` — exactly the behavior before ChatGPT/Gemini support
existed. Trying ChatGPT or Gemini on a role is opt-in: pick it from that
role's **Provider** dropdown in Settings, and give it a model id that
provider understands.

Saving a provider whose credential is not yet configured is allowed — the
pipeline does not block the save — but Settings shows a **credential
missing** badge next to that role, and the stage will fail fast (see below)
the next time it actually runs.

**Test connection.** Each provider's badge in Settings → Credentials has its
own **Test connection** button. It sends the literal message `"test"` to
that provider — outside the pipeline entirely, no task or workspace involved
— and toasts the reply (`"<Provider> responded: <text>"`) or a human-readable
error (missing credential, provider error, timeout after 20s). It uses a
small fixed model per provider for speed, not whatever model a role is
configured with, so it can fail or succeed independently of a role's own
setup.

---

## Claude (Anthropic)

**Environment variable:** set **exactly one** of:

| Variable | Mode |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription (default) — spends your Claude Pro/Max quota |
| `ANTHROPIC_API_KEY` | Pay-per-use — an Anthropic Console API key |

The subscription token wins if both are set.

**Where to get it:**
- Subscription: `npm i -g @anthropic-ai/claude-code`, then run
  `claude setup-token` and authenticate in the browser; paste the printed
  token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
- API key: create one at [console.anthropic.com](https://console.anthropic.com).

**How to select it:** Settings → pick **Claude (Anthropic)** as the provider
for a role (this is already the default for every role).

> Anthropic's policy on programmatic use of a subscription has changed more
> than once. Check the current terms before relying on subscription mode for
> sustained runs — switching to `ANTHROPIC_API_KEY` is an environment-variable
> change, no code changes needed.

---

## ChatGPT (OpenAI)

**Environment variable:** `OPENAI_API_KEY`

**Where to get it:** create an API key at
[platform.openai.com/api-keys](https://platform.openai.com/api-keys).

**How to select it:** Settings → pick **ChatGPT (OpenAI)** as the provider for
a role. The role's model tier resolves to `gpt-4.1-mini` (light), `gpt-4.1`
(default) or `o3` (heavy); a custom literal id is accepted for anything the
tier table does not cover.

**Running with the credential missing** fails the stage immediately with an
error naming `OPENAI_API_KEY`, before any API call is made.

---

## Gemini (Google)

**Environment variable:** `GEMINI_API_KEY` (or `GOOGLE_API_KEY` — either
name works; if both are set, `GOOGLE_API_KEY` wins, matching the underlying
`@google/genai` SDK's own precedence).

**Where to get it:** create an API key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**How to select it:** Settings → pick **Gemini (Google)** as the provider for
a role. The role's model tier resolves to `gemini-2.5-flash` (light) or
`gemini-2.5-pro` (default and heavy); a custom literal id is accepted for
anything the tier table does not cover.

**Running with the credential missing** fails the stage immediately with an
error naming `GEMINI_API_KEY`/`GOOGLE_API_KEY`, before any API call is made.

---

## Known differences between providers

- **Cost is an estimate for ChatGPT and Gemini, not a bill.** Claude's SDK
  reports `total_cost_usd` computed by Anthropic itself. OpenAI's and
  Gemini's chat APIs return only token counts; the dollar figure shown for
  those two is computed locally from a small, hand-maintained price table
  (`src/server/pipeline/providers/pricing.ts`) and will drift as providers
  change pricing. An unrecognized model id reports `$0` rather than guessing.
- **Tool execution is a younger code path for ChatGPT/Gemini.** Claude's SDK
  is a full local coding-agent harness: it executes Read/Grep/Glob/Bash/
  Edit/Write itself and only asks this app for a permission decision.
  OpenAI's and Gemini's SDKs only do model calls with function/tool-calling —
  this application executes the requested tool itself
  (`src/server/pipeline/providers/tool-runtime.ts`), confined by the same
  workspace sandbox and command allowlist Claude's path uses. Functionally
  equivalent, but far less battle-tested, especially on the write-capable
  roles (Developer, and any role you point at ChatGPT/Gemini that edits
  files).
- **Live-dashboard granularity is chunkier for ChatGPT/Gemini.** Claude
  streams partial thinking/tool events as they happen. The ChatGPT/Gemini
  loop only emits an event once each model turn completes, so the event feed
  updates in bigger steps. This is a UX difference, not a defect.
- **The model picker stores a tier, not a literal (stories.md S3).** Each
  role picks `light` / `default` / `heavy` — or a custom literal id, for a
  model the tier table does not know about yet — and the tier resolves to a
  provider-specific model id (`src/server/config/llm-providers.ts`'s
  `tierModels()`) at the moment the stage actually runs. Switching a role's
  provider therefore keeps it runnable without touching the model field; only
  a custom literal can still be provider-incompatible, the same way it always
  could.
- Neither ChatGPT's nor Gemini's session carries an SDK session id; both
  report `sessionId: null` in the stage's execution record, unlike Claude.

## Per-provider spend

Each provider has its own quota pool — Claude is split further by auth mode,
since a Pro/Max allowance and a metered bill are genuinely different things,
while ChatGPT and Gemini only ever bill per token. Limits, cadence and whether
exceeding one refuses a start are covered in
[`operations.md`](operations.md#spend).

## Files touched by a credential change

Nothing beyond `.env` (or the Settings screen's provider selector) needs to
change to configure a provider — this document plus [`.env.example`](../.env.example)
is everything a reviewer needs.
