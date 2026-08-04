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
  "A local software delivery pipeline staffed entirely by Claude agents. Describe a feature; get back a branch and an open pull request on GitHub, GitLab, Bitbucket or Azure DevOps.";

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
    tools: "Approve or reject",
    blurb:
      "You read the technical plan and say yes or no. Reading a plan is cheaper than writing one — and far cheaper than finding out the approach was wrong on a finished branch.",
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
      "Runs the test suite, the linter and the build, and verifies the acceptance criteria. The verdict fails closed: anything unparseable counts as a rejection.",
  },
  {
    id: "human-review",
    name: "Human code review",
    kind: "human",
    state: "HUMAN_CODE_REVIEW",
    produces: "human-review.md",
    tools: "Optional, chosen per task",
    blurb:
      "Opt in at creation and the task parks after QA until you read the diff. Your comment is persisted so it actually reaches the Developer's next prompt.",
  },
  {
    id: "homologation",
    name: "Homologation",
    kind: "agent",
    state: "PO_HOMOLOGATION",
    produces: "homolog-report.md",
    tools: "Read",
    blurb:
      "The Product Owner's last pass: does the delivered work answer the stories it was written from?",
  },
  {
    id: "stakeholder-gate",
    name: "Delivery gate",
    kind: "human",
    state: "STAKEHOLDER_GATE",
    produces: null,
    tools: "Always manual",
    blurb:
      "The second decision that is always yours. The plan gate can be waived for low-criticality work; this one cannot.",
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
    body: "A retry re-runs that stage as a new attempt recorded beside the failure. The brief, stories and plan you already paid for survive — and so do the clone and the branch.",
  },
];

export type Guardrail = {
  title: string;
  body: string;
  icon: "lock" | "eye" | "hand" | "shield" | "layers";
};

export const GUARDRAILS: Guardrail[] = [
  {
    icon: "layers",
    title: "Minimum-context handoff",
    body: "Each stage is a brand-new session with no resume. A prompt is assembled from three things only: the role's system prompt, the task metadata, and the Markdown artifacts the previous stages produced. No agent ever sees another agent's transcript.",
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
    body: "A new task sits in the Created column until you start it, and admission control is enforced when you press Start — not deep inside the worker. A card that says an agent is running means exactly that.",
  },
  {
    icon: "eye",
    title: "Code review runs before QA",
    body: "Reviewing a diff is cheap; QA runs the test suite, the linter and the build. A rejection costs one agent run to detect instead of two, and QA's prompt stays narrow: it verifies acceptance criteria and does not re-review code quality.",
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
    caption: "Subscription by default; an API key is an env-var swap.",
    code: `npm i -g @anthropic-ai/claude-code
claude setup-token       # authenticate in the browser
# paste it into .env as CLAUDE_CODE_OAUTH_TOKEN
# or set ANTHROPIC_API_KEY instead — the SDK picks up whichever is present`,
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
      "No — single user, no authentication. Do not expose the port publicly. This design assumes personal use with your own Claude subscription.",
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
      "The role system prompts are plain Markdown in prompts/. Each file is read once and cached for the life of the process, so restart the worker after editing one. Models per role, turn ceilings and limits are on the Settings screen, re-read at the start of every job.",
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
