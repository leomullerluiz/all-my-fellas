import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { RoleDefinition } from "../../agents/roles";
import { createPermissionGuard } from "../guardrails";

/**
 * Local execution of Read/Grep/Glob/Bash/Edit/Write for the OpenAI and Gemini
 * providers.
 *
 * Claude's SDK is a full local coding-agent harness: it executes these tools
 * itself and only asks this app for a permission decision. OpenAI's and
 * Gemini's SDKs only do model calls with function/tool-calling — executing a
 * requested tool is the caller's job, and this module is that job.
 *
 * Every call is gated through the same {@link createPermissionGuard} Claude's
 * path uses, so a role's tool allowlist, the Bash command allowlist, and the
 * workspace path confinement are enforced identically regardless of provider.
 */

const execFileAsync = promisify(execFile);

/** Cap on how much of a tool input is echoed into the event log. */
const TOOL_SUMMARY_CHARS = 240;

export function summarizeToolInput(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;

  const primary =
    (typeof record.command === "string" && record.command) ||
    (typeof record.file_path === "string" && record.file_path) ||
    (typeof record.pattern === "string" && record.pattern) ||
    (typeof record.path === "string" && record.path) ||
    (typeof record.description === "string" && record.description) ||
    "";

  const text = primary === "" ? JSON.stringify(record) : String(primary);
  return text.length > TOOL_SUMMARY_CHARS
    ? `${text.slice(0, TOOL_SUMMARY_CHARS)}…`
    : text;
}

export type ToolJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
};

/**
 * JSON-schema description of each built-in tool, shared by both new
 * providers' tool-calling APIs. Names and fields mirror the Claude Agent SDK
 * tools of the same name so a role's `allowedTools` list means the same thing
 * regardless of which provider is selected.
 */
const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  Read: {
    name: "Read",
    description: "Read a file from the task workspace, optionally a line range.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "number", description: "0-based line to start from." },
        limit: { type: "number", description: "Maximum number of lines to return." },
      },
      required: ["file_path"],
    },
  },
  Grep: {
    name: "Grep",
    description: "Search file contents for a regular expression pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory to search, relative to the workspace root." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. **/*.ts." },
        "-i": { type: "boolean", description: "Case-insensitive search." },
      },
      required: ["pattern"],
    },
  },
  Glob: {
    name: "Glob",
    description: "List files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts." },
        path: { type: "string", description: "Directory to search from, relative to the workspace root." },
      },
      required: ["pattern"],
    },
  },
  Bash: {
    name: "Bash",
    description: "Run a shell command in the task workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        description: { type: "string", description: "Short human-readable summary of the command." },
      },
      required: ["command"],
    },
  },
  Edit: {
    name: "Edit",
    description: "Replace an exact string in a file with another string.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  Write: {
    name: "Write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["file_path", "content"],
    },
  },
};

/** Tool schemas for the tools a role is allowed to use, in the role's order. */
export function toolSchemasForRole(role: RoleDefinition): ToolSchema[] {
  return role.allowedTools
    .map((name) => TOOL_SCHEMAS[name])
    .filter((schema): schema is ToolSchema => schema !== undefined);
}

export type ToolExecutionResult = { output: string; isError: boolean };

function resolveInWorkspace(workspacePath: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspacePath, candidate);
}

/** Turns a glob pattern into a `RegExp` matched against a `/`-separated relative path. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (".+^${}()|[]\\".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Directories skipped by Grep/Glob's recursive walk. */
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git", ".next", "dist", "build"]);

async function walkFiles(
  root: string,
  visit: (filePath: string) => Promise<boolean>,
): Promise<void> {
  async function walk(dir: string): Promise<boolean> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
        const keepGoing = await walk(path.join(dir, entry.name));
        if (!keepGoing) return false;
      } else if (entry.isFile()) {
        const keepGoing = await visit(path.join(dir, entry.name));
        if (!keepGoing) return false;
      }
    }
    return true;
  }
  await walk(root);
}

const MAX_GREP_MATCHES = 200;
const MAX_GLOB_RESULTS = 500;

async function readTool(workspacePath: string, input: Record<string, unknown>): Promise<string> {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (filePath === "") throw new Error("Read requires file_path.");

  const resolved = resolveInWorkspace(workspacePath, filePath);
  const content = await fs.readFile(resolved, "utf8");
  const lines = content.split("\n");
  const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : 0;
  const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 2000;
  const selected = lines.slice(offset, offset + limit);

  return selected.map((line, index) => `${offset + index + 1}\t${line}`).join("\n");
}

async function grepTool(workspacePath: string, input: Record<string, unknown>): Promise<string> {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (pattern === "") throw new Error("Grep requires a pattern.");

  const searchRoot = resolveInWorkspace(
    workspacePath,
    typeof input.path === "string" && input.path !== "" ? input.path : ".",
  );
  const globFilter = typeof input.glob === "string" && input.glob !== "" ? globToRegExp(input.glob) : null;
  const ignoreCase = input["-i"] === true;
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");
  const matches: string[] = [];

  await walkFiles(searchRoot, async (filePath) => {
    const relative = path.relative(workspacePath, filePath).split(path.sep).join("/");
    if (globFilter && !globFilter.test(relative)) return true;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      // Binary or unreadable file — skip it rather than fail the whole search.
      return true;
    }

    for (const [index, line] of content.split("\n").entries()) {
      if (regex.test(line)) {
        matches.push(`${relative}:${index + 1}:${line}`);
        if (matches.length >= MAX_GREP_MATCHES) return false;
      }
    }
    return true;
  });

  return matches.length > 0 ? matches.join("\n") : "No matches found.";
}

async function globTool(workspacePath: string, input: Record<string, unknown>): Promise<string> {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (pattern === "") throw new Error("Glob requires a pattern.");

  const searchRoot = resolveInWorkspace(
    workspacePath,
    typeof input.path === "string" && input.path !== "" ? input.path : ".",
  );
  const regex = globToRegExp(pattern);
  const found: string[] = [];

  await walkFiles(searchRoot, async (filePath) => {
    const relative = path.relative(workspacePath, filePath).split(path.sep).join("/");
    if (regex.test(relative)) found.push(relative);
    return found.length < MAX_GLOB_RESULTS;
  });

  return found.length > 0 ? found.join("\n") : "No files found.";
}

async function bashTool(
  workspacePath: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const command = typeof input.command === "string" ? input.command : "";
  if (command === "") throw new Error("Bash requires a command.");

  try {
    const { stdout, stderr } =
      process.platform === "win32"
        ? await execFileAsync("cmd.exe", ["/d", "/s", "/c", command], {
            cwd: workspacePath,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          })
        : await execFileAsync("/bin/sh", ["-c", command], {
            cwd: workspacePath,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          });
    const output = [stdout, stderr].filter((part) => part.trim() !== "").join("\n").trim();
    return { output: output === "" ? "(no output)" : output, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: message, isError: true };
  }
}

async function editTool(workspacePath: string, input: Record<string, unknown>): Promise<string> {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";
  const replaceAll = input.replace_all === true;
  if (filePath === "" || oldString === "") {
    throw new Error("Edit requires file_path and old_string.");
  }

  const resolved = resolveInWorkspace(workspacePath, filePath);
  const content = await fs.readFile(resolved, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_string was not found in ${filePath}.`);
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string is not unique in ${filePath} (${occurrences} matches). ` +
        "Pass replace_all or a more specific string.",
    );
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  await fs.writeFile(resolved, updated, "utf8");
  return `Updated ${filePath}.`;
}

async function writeTool(workspacePath: string, input: Record<string, unknown>): Promise<string> {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  const content = typeof input.content === "string" ? input.content : "";
  if (filePath === "") throw new Error("Write requires a file_path.");

  const resolved = resolveInWorkspace(workspacePath, filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
  return `Wrote ${filePath} (${content.length} bytes).`;
}

/**
 * Executes one tool call, gated by the same permission guard Claude's own
 * path uses.
 *
 * @param role Role executing the tool, deciding allowlist and write access.
 * @param workspacePath Absolute path the call is confined to.
 */
export async function executeTool(
  toolName: string,
  rawInput: unknown,
  role: RoleDefinition,
  workspacePath: string,
): Promise<ToolExecutionResult> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const guard = createPermissionGuard(role, workspacePath);
  const verdict = await guard(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    requestId: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  });

  // `CanUseTool`'s type allows `null` for an out-of-band response, which this
  // guard never does; treat it the same as a denial rather than crash.
  if (verdict === null || verdict.behavior === "deny") {
    return {
      output: verdict?.behavior === "deny" ? verdict.message : "Blocked by the pipeline sandbox.",
      isError: true,
    };
  }

  try {
    switch (toolName) {
      case "Read":
        return { output: await readTool(workspacePath, input), isError: false };
      case "Grep":
        return { output: await grepTool(workspacePath, input), isError: false };
      case "Glob":
        return { output: await globTool(workspacePath, input), isError: false };
      case "Bash":
        return await bashTool(workspacePath, input);
      case "Edit":
        return { output: await editTool(workspacePath, input), isError: false };
      case "Write":
        return { output: await writeTool(workspacePath, input), isError: false };
      default:
        return { output: `Unknown tool "${toolName}".`, isError: true };
    }
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), isError: true };
  }
}
