import path from "node:path";

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type { RoleDefinition } from "../agents/roles";

/**
 * Runtime sandbox for agent sessions.
 *
 * `cwd` alone is not a boundary: an agent can still pass an absolute path to
 * Read/Edit, or `cd` elsewhere in a Bash command. This module is the actual
 * enforcement point, wired in as the SDK's `canUseTool` callback.
 */

/** Tools whose input carries a filesystem path we must confine to the workspace. */
const PATH_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);

/** Bash prefixes the read-only roles (Architect, QA) may run. */
const READ_ONLY_BASH_ALLOWLIST = [
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git rev-parse",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "tree",
  "node --version",
  "npm --version",
  "npm ls",
  "npm test",
  "npm run lint",
  "npm run test",
  "npm run build",
  "npm run typecheck",
  "npx tsc",
  "pnpm test",
  "pnpm lint",
  "pnpm build",
  "yarn test",
  "yarn lint",
  "yarn build",
  "pytest",
  "go test",
  "cargo test",
  "make test",
];

/**
 * Command fragments rejected for every role, including the Developer.
 *
 * These are the operations that either escape the workspace, exfiltrate data,
 * or hand control of the machine to remote content.
 */
const DENIED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[\s;&|(])sudo(\s|$)/, reason: "privilege escalation is not allowed" },
  { pattern: /(^|[\s;&|(])su(\s|$)/, reason: "privilege escalation is not allowed" },
  { pattern: /rm\s+(-[a-zA-Z]*\s+)*(-rf|-fr|-r\s+-f)/, reason: "recursive force delete" },
  { pattern: /\bcurl\b[\s\S]*\|\s*(ba)?sh/, reason: "piping a download into a shell" },
  { pattern: /\bwget\b[\s\S]*\|\s*(ba)?sh/, reason: "piping a download into a shell" },
  { pattern: /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)(\s|$)/, reason: "host power control" },
  { pattern: /(^|[\s;&|(])(mkfs|fdisk|diskpart)(\s|$)/, reason: "disk operation" },
  { pattern: /(^|[\s;&|(])chmod\s+(-R\s+)?777/, reason: "world-writable permissions" },
  { pattern: /\bgit\s+push\b/, reason: "the worker owns pushing, not the agent" },
  { pattern: /\bgit\s+remote\s+(add|set-url)\b/, reason: "remotes are managed by the worker" },
  {
    // Provider CLIs as a family. Mostly moot now that delivery calls REST
    // directly, but a blocklist that lags behind a new provider fails open.
    pattern: /(^|[\s;&|(])(gh|glab|az|bb|tf)(\s|$)/,
    reason: "provider CLI access is reserved for the worker",
  },
  { pattern: /\bnpm\s+publish\b/, reason: "publishing is out of scope for the pipeline" },
  { pattern: /\.env(\.[a-z]+)?\b/, reason: "environment files may hold credentials" },
  { pattern: /\b(id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.npmrc)\b/, reason: "credential material" },
  { pattern: /\bprintenv\b|\benv\s*$|\bset\s*$/, reason: "dumping the environment" },
  {
    /**
     * Any variable that looks like a secret, rather than an enumerated list.
     *
     * Enumerating them meant every new provider silently widened the hole
     * until someone remembered to add `GITLAB_TOKEN` here. This matches the
     * shape instead, so an unknown credential variable is covered on the day
     * it is introduced.
     */
    pattern: /\$\{?[A-Za-z_][A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)/i,
    reason: "reading a credential variable",
  },
];

function allow(): PermissionResult {
  return { behavior: "allow" };
}

function deny(message: string): PermissionResult {
  return { behavior: "deny", message };
}

/** True when `candidate` resolves inside `root` (or is `root` itself). */
export function isInsideWorkspace(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Collects every value in a tool input that looks like a filesystem path. */
function pathsInInput(input: Record<string, unknown>): string[] {
  const keys = ["file_path", "path", "notebook_path", "filePath"];
  const found: string[] = [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) found.push(value);
  }
  return found;
}

export function checkBashCommand(
  command: string,
  role: RoleDefinition,
): { ok: true } | { ok: false; reason: string } {
  const normalized = command.trim();

  for (const { pattern, reason } of DENIED_BASH_PATTERNS) {
    if (pattern.test(normalized)) {
      return { ok: false, reason: `Command blocked (${reason}).` };
    }
  }

  if (role.canWrite) return { ok: true };

  // Read-only roles run against an allowlist. Split on shell separators so a
  // permitted prefix cannot smuggle a second command behind `&&` or `;`.
  const segments = normalized
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    const permitted = READ_ONLY_BASH_ALLOWLIST.some(
      (prefix) => segment === prefix || segment.startsWith(`${prefix} `),
    );
    if (!permitted) {
      return {
        ok: false,
        reason:
          `The ${role.name} role may only run read-only inspection commands. ` +
          `"${segment}" is not on the allowlist.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Builds the `canUseTool` callback for one stage run.
 *
 * @param role Role being executed, which decides write access and Bash rules.
 * @param workspacePath Absolute path the session is confined to, or `null` for
 *   text-only roles that get no filesystem at all.
 */
export function createPermissionGuard(
  role: RoleDefinition,
  workspacePath: string | null,
): CanUseTool {
  return async (toolName, input) => {
    if (!role.allowedTools.includes(toolName)) {
      return deny(`The ${role.name} role is not permitted to use ${toolName}.`);
    }

    if (workspacePath === null) {
      return deny(`The ${role.name} role runs without filesystem access.`);
    }

    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      const verdict = checkBashCommand(command, role);
      if (!verdict.ok) return deny(verdict.reason);

      // `cd` out of the workspace would defeat every path check below.
      for (const match of command.matchAll(/(?:^|[\s;&|(])cd\s+("[^"]+"|'[^']+'|\S+)/g)) {
        const target = match[1].replace(/^["']|["']$/g, "");
        if (!isInsideWorkspace(workspacePath, target)) {
          return deny(`Command blocked: cannot change directory outside the task workspace.`);
        }
      }
      return allow();
    }

    if (PATH_TOOLS.has(toolName)) {
      for (const candidate of pathsInInput(input)) {
        if (!isInsideWorkspace(workspacePath, candidate)) {
          return deny(
            `Path "${candidate}" is outside the task workspace and cannot be accessed.`,
          );
        }
      }
    }

    return allow();
  };
}
