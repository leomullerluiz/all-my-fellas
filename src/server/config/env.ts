import path from "node:path";

/**
 * Environment access for both the Next.js process and the worker process.
 *
 * Nothing here is cached across calls: the worker is long lived and reads a
 * `.env` file that the user may edit while it runs.
 */

const PROJECT_ROOT = process.cwd();

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Turns `DATABASE_URL` into an absolute filesystem path. Accepts both the
 * `file:./data/pipeline.db` URL form and a bare relative/absolute path.
 */
export function resolveDatabaseFile(): string {
  const raw = str("DATABASE_URL", "file:./data/pipeline.db");
  const withoutScheme = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  return path.isAbsolute(withoutScheme)
    ? withoutScheme
    : path.resolve(/* turbopackIgnore: true */ PROJECT_ROOT, withoutScheme);
}

export function resolveWorkspacesDir(): string {
  const raw = str("WORKSPACES_DIR", "./workspaces");
  return path.isAbsolute(raw)
    ? raw
    : path.resolve(/* turbopackIgnore: true */ PROJECT_ROOT, raw);
}

export function resolvePromptsDir(): string {
  return path.resolve(/* turbopackIgnore: true */ PROJECT_ROOT, "prompts");
}

export type AuthMode = "subscription" | "api_key" | "missing";

export type ProviderAuth = {
  mode: AuthMode;
  /** Human readable description shown on the Settings screen. */
  label: string;
};

/**
 * Decides which Claude credential the Agent SDK will pick up.
 *
 * The subscription token wins when both are present, matching the SDK's own
 * precedence, so the UI never claims a billing mode that is not in effect.
 */
export function resolveProviderAuth(): ProviderAuth {
  if (str("CLAUDE_CODE_OAUTH_TOKEN", "") !== "") {
    return { mode: "subscription", label: "Claude subscription (OAuth token)" };
  }
  if (str("ANTHROPIC_API_KEY", "") !== "") {
    return { mode: "api_key", label: "Anthropic API key (pay per use)" };
  }
  return { mode: "missing", label: "No Claude credential configured" };
}

/**
 * Decides which OpenAI credential the ChatGPT provider will pick up.
 *
 * Mirrors {@link resolveProviderAuth}'s shape so the Settings screen and the
 * `assertProviderConfigured` family can treat every LLM provider uniformly.
 */
export function resolveOpenAiAuth(): ProviderAuth {
  if (str("OPENAI_API_KEY", "") !== "") {
    return { mode: "api_key", label: "OpenAI API key (pay per use)" };
  }
  return { mode: "missing", label: "No OpenAI credential configured" };
}

/**
 * Decides which Gemini credential the Gemini provider will pick up.
 *
 * `GOOGLE_API_KEY` is accepted as an alias: it is the variable name Google's
 * own docs use in some SDKs, and the underlying `@google/genai` SDK already
 * reads either one itself, with `GOOGLE_API_KEY` winning if both are set.
 */
export function resolveGeminiAuth(): ProviderAuth {
  if (str("GOOGLE_API_KEY", "") !== "") {
    return { mode: "api_key", label: "Gemini API key (via GOOGLE_API_KEY)" };
  }
  if (str("GEMINI_API_KEY", "") !== "") {
    return { mode: "api_key", label: "Gemini API key (pay per use)" };
  }
  return { mode: "missing", label: "No Gemini credential configured" };
}

export function hasGithubToken(): boolean {
  return str("GITHUB_TOKEN", "") !== "";
}

/**
 * Author recorded on commits the pipeline makes itself.
 *
 * Configurable because the default shows up in the history of the user's own
 * repository, where "pipeline@localhost" may not be acceptable.
 */
export function resolveGitIdentity(): { name: string; email: string } {
  return {
    name: str("GIT_AUTHOR_NAME", "All My Fellas Pipeline"),
    email: str("GIT_AUTHOR_EMAIL", "pipeline@localhost"),
  };
}

export type ModelTierConfig = {
  light: string;
  default: string;
  heavy: string;
};

export function resolveModels(): ModelTierConfig {
  return {
    light: str("MODEL_LIGHT", "claude-haiku-4-5"),
    default: str("MODEL_DEFAULT", "claude-sonnet-5"),
    heavy: str("MODEL_HEAVY", "claude-opus-5"),
  };
}

export type RuntimeLimits = {
  maxParallelTasks: number;
  reworkMaxCycles: number;
  workspaceRetentionDays: number;
};

export function resolveLimits(): RuntimeLimits {
  return {
    maxParallelTasks: Math.max(1, int("MAX_PARALLEL_TASKS", 1)),
    // Renamed from QA_MAX_CYCLES now that code review and the human gate share
    // the same budget. The old name is still honoured so existing `.env` files
    // keep working.
    reworkMaxCycles: Math.max(0, int("REWORK_MAX_CYCLES", int("QA_MAX_CYCLES", 2))),
    workspaceRetentionDays: Math.max(0, int("WORKSPACE_RETENTION_DAYS", 7)),
  };
}
