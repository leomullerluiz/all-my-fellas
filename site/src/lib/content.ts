/**
 * Every claim on the landing page lives here, sourced from the project README.
 * Keeping the copy in one typed module is what stops the marketing text and the
 * documentation from drifting apart: when the pipeline changes, this file is the
 * single place the site has to follow.
 */

export const REPO_URL = "https://github.com/leomullerluiz/all-my-fellas";

/**
 * Canonical origin + path of the published site. Every absolute URL the page
 * emits — canonical link, OG image, sitemap entries — is built from this, so a
 * move to a custom domain is one environment variable rather than a grep.
 *
 * Must agree with `NEXT_PUBLIC_BASE_PATH` in next.config.ts: this carries the
 * origin *and* the subpath, that one carries the subpath alone.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://leomullerluiz.github.io/all-my-fellas"
).replace(/\/$/, "");

export const SITE_NAME = "All My Fellas";

export const SITE_DESCRIPTION =
  "A local software delivery pipeline staffed by LLM agents — Claude, ChatGPT or Gemini, picked per role. Describe a feature; get back a branch and an open pull request on GitHub, GitLab, Bitbucket or Azure DevOps.";

export type StageKind = "agent" | "human" | "worker";

export type Stage = {
  id: string;
  name: string;
  kind: StageKind;
  /** Machine stage name, as it appears on a task card in the dashboard. */
  state: string;
  produces: string | null;
  tools: string;
  blurb: string;
};

export const STAGES: Stage[] = [
  {
    id: "stakeholder",
    name: "Stakeholder",
    kind: "agent",
    state: "STAKEHOLDER_REFINEMENT",
    produces: "brief.md",
    tools: "No tools",
    blurb:
      "Reads the raw request and writes the brief: the problem, who has it, and what “done” has to mean. No filesystem access at all.",
  },
  {
    id: "po",
    name: "Product Owner",
    kind: "agent",
    state: "PO_REFINEMENT",
    produces: "stories.md",
    tools: "Read · Grep · Glob",
    blurb:
      "Turns the brief into user stories with acceptance criteria, reading the repository to keep them grounded in what exists.",
  },
  {
    id: "architect",
    name: "Architect",
    kind: "agent",
    state: "ARCHITECTURE",
    produces: "techplan.md",
    tools: "Read · Grep · Glob · Bash (read-only)",
    blurb:
      "Explores the real code before choosing an approach, so its difficulty and criticality estimates come from the codebase rather than from the prompt.",
  },
  {
    id: "plan-gate",
    name: "Plan gate",
    kind: "human",
    state: "PLAN_GATE",
    produces: null,
    tools: "Approve · request changes · reject",
    blurb:
      "You read the technical plan and say yes, no, or redo this part — a request for changes re-runs the Architect and is not charged to the rework budget. Reading a plan is cheaper than writing one, and far cheaper than finding out the approach was wrong on a finished branch.",
  },
  {
    id: "developer",
    name: "Developer",
    kind: "agent",
    state: "DEVELOPMENT",
    produces: "commits + dev-report.md",
    tools: "Read · Grep · Glob · Bash · Edit · Write",
    blurb:
      "The only role that can write files, and only inside the task's own clone. Commits the work and reports what it did.",
  },
  {
    id: "verification",
    name: "Verification",
    kind: "worker",
    state: "VERIFICATION",
    produces: "verification-report.md",
    tools: "Worker, not an agent",
    blurb:
      "Runs this repository's configured install/build/test/lint commands and routes on the real exit codes. A failure goes straight back to the Developer — no reviewer or QA session is paid for.",
  },
  {
    id: "code-review",
    name: "Code Reviewer",
    kind: "agent",
    state: "CODE_REVIEW",
    produces: "code-review-report.md",
    tools: "Read · Grep · Glob · Bash",
    blurb:
      "A separate session that never sees the Developer's transcript — only the criteria, the written report and the branch diff. Changes requested sends the work back.",
  },
  {
    id: "qa",
    name: "QA",
    kind: "agent",
    state: "QA",
    produces: "qa-report.md",
    tools: "Read · Grep · Glob · Bash",
    blurb:
      "Verifies the acceptance criteria against the pipeline's own verification results, not a suite it claims to have run itself. The verdict fails closed: anything unparseable counts as a rejection.",
  },
  {
    id: "human-review",
    name: "Human code review",
    kind: "human",
    state: "HUMAN_CODE_REVIEW",
    produces: "human-review.md",
    tools: "Optional, chosen per task",
    blurb:
      "Opt in at creation and the task parks after QA until you read the diff. Your comment is persisted so it actually reaches the Developer's next prompt — or fix one line by hand and commit it from that screen, instead of spending a whole rework cycle.",
  },
  {
    id: "homologation",
    name: "Homologation",
    kind: "agent",
    state: "PO_HOMOLOGATION",
    produces: "homolog-report.md",
    tools: "Read",
    blurb:
      "The Product Owner's last pass: does the delivered work answer the stories it was written from? A rejection returns the work once, then escalates to a human — a repeated no is usually a problem with the acceptance criteria, and no agent here can rewrite those.",
  },
  {
    id: "stakeholder-gate",
    name: "Delivery gate",
    kind: "human",
    state: "STAKEHOLDER_GATE",
    produces: null,
    tools: "Approve · request changes · reject",
    blurb:
      "The second decision that is yours. A homologation escalation always lands here, whatever else has been automated away.",
  },
  {
    id: "delivery",
    name: "Delivery",
    kind: "worker",
    state: "DELIVERY",
    produces: "branch + change request",
    tools: "Worker, not an agent",
    blurb:
      "Pushes the branch, then opens the pull request through the host's API. If that call fails the push still stands and you get a pre-filled link — delivery degrades rather than fails.",
  },
];

export type Pillar = {
  title: string;
  lede: string;
  body: string;
};

export const PILLARS: Pillar[] = [
  {
    title: "Writing the spec is the expensive part",
    lede: "You write a title and a description.",
    body: "The brief, the user stories and the technical plan are produced for you. Handing a feature to a single agent means authoring the plan yourself first — and authoring it again when the first attempt comes back wrong.",
  },
  {
    title: "A reviewer that shares your context is not a reviewer",
    lede: "Independence is in the context, not the model.",
    body: "Ask one session to write the code and then check it, and the check is done by the thing that already talked itself into the code. Code Review and QA are separate calls that never see the Developer's transcript, and their verdicts fail closed.",
  },
  {
    title: "Your attention goes to decisions, not turns",
    lede: "Two decisions by default.",
    body: "The technical plan and the delivery, plus a diff review if the task opted into one. Each is a document you read on your own schedule rather than a session you supervise turn by turn.",
  },
  {
    title: "A wrong turn costs one stage, not the run",
    lede: "Every stage leaves a validated artifact.",
    body: "A retry re-runs that stage as a new attempt recorded beside the failure. The task remembers why it failed, so the retry knows what to re-run rather than guessing — and the brief, stories, plan, clone and branch you already paid for all survive.",
  },
  {
    title: "Nothing claims a check it did not run",
    lede: "Exit codes, not adjectives.",
    body: "Install, build, test and lint are run by the pipeline itself between Development and Code Review. A red suite goes straight back to the Developer without paying for a reviewer or a QA session, and QA receives the real result as an input instead of describing one.",
  },
  {
    title: "Walking away is the feature",
    lede: "So it has to be safe.",
    body: "A configured quota can refuse a start rather than colour a bar red. A task can carry a spend ceiling that stops it. Cancel aborts the session in flight. The worker proves it is alive, and a desktop notification or a webhook tells you the moment a gate needs you.",
  },
];

export type Guardrail = {
  title: string;
  body: string;
  icon: "lock" | "eye" | "hand" | "shield" | "layers" | "history";
};

export const GUARDRAILS: Guardrail[] = [
  {
    icon: "layers",
    title: "Minimum-context handoff",
    body: "Each stage is a brand-new session with no resume. A prompt is assembled from a fixed, auditable list: the role's system prompt, the task metadata, the Markdown artifacts the previous stages produced, and a few declared supplements — the diff for reviewers, the verification result, the task's attachments, the repository's own conventions file. No agent ever sees another agent's transcript.",
  },
  {
    icon: "lock",
    title: "Least privilege per role",
    body: "Only the Developer can write files. The Architect and QA get Bash restricted to an inspection allowlist. The Stakeholder gets no filesystem at all. Every tool call passes a guard that confines paths to the task workspace.",
  },
  {
    icon: "shield",
    title: "The agents never hold credentials",
    body: "Cloning, pushing and opening the change request are done by the worker. The token is injected into a remote URL for the length of one command, and never written to .git/config, the database, or an agent's environment.",
  },
  {
    icon: "hand",
    title: "Nothing starts on its own",
    body: "A new task sits in the Created column until you start it, and admission control is enforced when you press Start — not deep inside the worker. The board separates admitted from in flight, so a card that says an agent is running means exactly that; the rest say what they are waiting for.",
  },
  {
    icon: "eye",
    title: "Mechanical verification runs before any reviewer",
    body: "The pipeline — not an agent — runs this repository's configured install/build/test/lint commands right after Development and routes on the real exit codes. A failure goes straight back to the Developer with no reviewer or QA session paid for, and QA receives the real results as an input instead of claiming to have run the checks itself.",
  },
  {
    icon: "history",
    title: "Everything it did is readable afterwards",
    body: "Every run keeps the exact prompt it was sent, the model and provider that answered, and the full transcript with secrets redacted — every tool call, with its real input. Artifacts keep every version, not just the newest, and one task exports as a single JSON file.",
  },
];

export type Control = {
  title: string;
  body: string;
};

/**
 * The operational surface — what exists so a task can be started and left
 * alone. Ordered as the questions arrive: what stops it, how do I know it is
 * alive, how do I hear about it, and how do I find anything a week later.
 */
export const CONTROLS: Control[] = [
  {
    title: "Spend has a valve",
    body: "A quota is per provider pool, with a daily, hourly or monthly cadence, and you choose what it does: read out, warn, or refuse the start with an explicit override. Separately, a per-stage ceiling stops a session from inside and a per-task ceiling stops the next stage being scheduled at all.",
  },
  {
    title: "Stop means stop",
    body: "Cancel aborts the running session rather than only marking rows. Pause lets the current stage finish and then waits. A global hold stops the worker claiming anything new without touching what is already running.",
  },
  {
    title: "The worker proves it is alive",
    body: "It writes a heartbeat; the nav shows healthy, lagging or stale, and a health endpoint returns a non-2xx status for anything worse — which is what the Docker healthcheck reads. A worker that died mid-stage is reported as interrupted, and its claimed job returns to the queue on restart.",
  },
  {
    title: "It tells you when it needs you",
    body: "Desktop notifications, once you have granted permission, and an outbound webhook with an optional HMAC signature — Slack, ntfy, n8n, your own script. Per event type, with only the moments that block a human enabled by default.",
  },
  {
    title: "A board that survives a hundred tasks",
    body: "Search, filters by repository, priority and status, a sortable list view for finding last week's work, archiving for anything finished, and a cross-task activity feed. Cards say how long they have been where they are, and undelivered ones say whether they failed, were rejected or were cancelled.",
  },
  {
    title: "Unattended access, if you want it",
    body: "The API is open on localhost by default. Mint a bearer token and it closes for every request — enough for a CI job to file a task, or for you to approve a gate from a phone. Actions taken with a token are recorded under its name.",
  },
];

export type Provider = {
  name: string;
  requestName: string;
  variable: string;
  note: string;
  integrated: boolean;
};

export const PROVIDERS: Provider[] = [
  {
    name: "GitHub",
    requestName: "Pull request",
    variable: "GITHUB_TOKEN",
    note: "repo scope",
    integrated: true,
  },
  {
    name: "GitLab",
    requestName: "Merge request",
    variable: "GITLAB_TOKEN",
    note: "api, write_repository — self-managed instances too",
    integrated: true,
  },
  {
    name: "Bitbucket Cloud",
    requestName: "Pull request",
    variable: "BITBUCKET_TOKEN",
    note: "repository:write, pullrequest:write",
    integrated: true,
  },
  {
    name: "Azure DevOps",
    requestName: "Pull request",
    variable: "AZURE_DEVOPS_TOKEN",
    note: "Code read & write, Pull Request Contribute",
    integrated: true,
  },
  {
    name: "Any git server",
    requestName: "Push only",
    variable: "you name it",
    note: "Gitea, an internal server: the branch is pushed, you open the request",
    integrated: false,
  },
];

export type CommandTab = {
  value: string;
  label: string;
  caption: string;
  code: string;
};

export const COMMAND_TABS: CommandTab[] = [
  {
    value: "setup",
    label: "Setup",
    caption: "Node ≥ 20.9 and git on PATH. No provider CLI needed.",
    code: `git clone https://github.com/leomullerluiz/all-my-fellas
cd all-my-fellas
npm install
cp .env.example .env    # then fill it in`,
  },
  {
    value: "credentials",
    label: "Credentials",
    caption:
      "Subscription by default; an API key is an env-var swap. ChatGPT and Gemini are optional — set one only to point a role at it.",
    code: `npm i -g @anthropic-ai/claude-code
claude setup-token       # authenticate in the browser
# paste it into .env as CLAUDE_CODE_OAUTH_TOKEN
# or set ANTHROPIC_API_KEY instead — the SDK picks up whichever is present

# optional, per role, from Settings:
# OPENAI_API_KEY=...      ChatGPT
# GEMINI_API_KEY=...      Gemini`,
  },
  {
    value: "run",
    label: "Run",
    caption: "Next.js on :3000 and the worker, together.",
    code: `npm run dev

# or separately
npm run dev:web
npm run dev:worker`,
  },
  {
    value: "production",
    label: "Production",
    caption: "Not serverless: agent sessions run for minutes and the dashboard holds an SSE connection open.",
    code: `npm run build     # next build + tsc for the worker
npm start         # next start + node dist/worker/index.js

# or self-hosted
docker compose up -d`,
  },
  {
    value: "unattended",
    label: "Unattended",
    caption:
      "The API is open on localhost until the first token exists; from then on every request needs one. Restore is deliberately manual: stop both processes and copy the file back.",
    code: `npm run token:create -- --name=CI    # printed once, stored as a hash
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/tasks

npm run db:backup                    # → data/backups/pipeline-<timestamp>.db
curl localhost:3000/api/health       # 503 when the worker is stale`,
  },
];

export type Faq = {
  value: string;
  question: string;
  answer: string;
};

export const FAQ: Faq[] = [
  {
    value: "merge",
    question: "Does it merge the pull request?",
    answer:
      "No. Merging is always manual, on the host. The pipeline pushes the branch and opens the change request; the last click is yours.",
  },
  {
    value: "cost",
    question: "Is this cheaper than doing it myself?",
    answer:
      "Not for a one-line fix — that is faster by hand than seven agent stages and two gates. It earns its cost on work you would have written a plan for anyway. Cost figures come from the Agent SDK's own total_cost_usd; in subscription mode they estimate equivalent API spend rather than a bill, and /usage tells you which stage spent it.",
  },
  {
    value: "hosting",
    question: "Can I deploy it serverless?",
    answer:
      "No. A stage takes minutes and streams continuously, which does not fit a request/response cycle. The worker owns all execution and the web app only reads state; the two talk through SQLite in WAL mode. Run it locally or self-host it — docker-compose.yml covers that case.",
  },
  {
    value: "auth",
    question: "Is it multi-user?",
    answer:
      "No — single user, and the dashboard has no authentication. An optional bearer token can gate the API for a CI job or a phone, but it is a label rather than an identity: it grants everything, and what its name buys you is attribution in the audit log. Do not expose the port publicly. This design assumes personal use with your own subscription.",
  },
  {
    value: "providers",
    question: "Does it have to be Claude?",
    answer:
      "No. Every role runs on Claude, ChatGPT or Gemini, chosen per role in Settings, and a role stores a tier rather than a model id — so switching its provider does not strand it on a model the new one has never heard of. Claude is the default everywhere and needs no configuration change. The differences are documented: only Claude reports a real dollar figure, and the tool-execution path for the other two is younger.",
  },
  {
    value: "away",
    question: "What happens while I am not watching?",
    answer:
      "Whatever you configured. A quota can refuse a start instead of warning about it, a spend ceiling can stop a task mid-run, a gate can reach you by desktop notification or webhook, and the worker's heartbeat says whether anything is running at all. Nothing merges, and nothing starts on its own.",
  },
  {
    value: "self-hosted",
    question: "What about self-hosted git?",
    answer:
      "A self-managed GitLab has a full API integration — pick the provider explicitly and point API base URL at the instance. GitHub Enterprise Server, Bitbucket Data Center and Azure DevOps Server speak APIs that differ from their cloud siblings by more than a base URL, so they run as generic connections: cloning, branching and pushing all work, and you open the request yourself.",
  },
  {
    value: "prompts",
    question: "Can I change what the agents do?",
    answer:
      "The role system prompts are plain Markdown in prompts/. Each file is read once and cached for the life of the process, so restart the worker after editing one. Provider and model tier per role, turn ceilings and limits are on the Settings screen, re-read at the start of every job.",
  },
  {
    value: "audit",
    question: "Can I see what an agent actually did?",
    answer:
      "Yes. Every run keeps the exact prompt it was sent, the model and provider that answered, its token counts and cost, and the full transcript — every tool call with its real input, and denials with the real reason — normalised across providers and scrubbed of anything credential-shaped. Artifacts keep every version, and a whole task exports as one JSON file.",
  },
];

export type Stat = {
  value: number;
  suffix?: string;
  label: string;
  detail: string;
};

export const STATS: Stat[] = [
  { value: 7, label: "agent stages", detail: "Stakeholder through homologation" },
  { value: 2, label: "human gates", detail: "Plus an optional diff review" },
  { value: 5, label: "git hosts", detail: "Four APIs and a generic fallback" },
  { value: 0, label: "credentials to agents", detail: "The worker holds every token" },
];
