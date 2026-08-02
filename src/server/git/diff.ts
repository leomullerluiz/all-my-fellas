import simpleGit from "simple-git";

/**
 * Reads the task branch's diff against its base.
 *
 * The diff is computed live from the workspace rather than persisted: diffs run
 * to megabytes and the screen is usually opened once. During the human review
 * gate the workspace is guaranteed to exist — the task is mid-pipeline, well
 * before the cleanup job.
 */

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffFile = {
  path: string;
  /** Present only for renames. */
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DiffIndex = {
  baseBranch: string;
  files: DiffFile[];
  /** True when the file list was capped. */
  truncated: boolean;
  totalAdditions: number;
  totalDeletions: number;
};

/** Beyond this the file list is capped; the UI warns rather than hanging. */
const MAX_FILES = 500;
/** A single patch above this is cut with an explicit marker. */
export const MAX_PATCH_BYTES = 200_000;

function statusFromCode(code: string): DiffStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      return "modified";
  }
}

/** Splits NUL-delimited git output, dropping the trailing empty token. */
function tokens(output: string): string[] {
  return output.split("\0").filter((token) => token !== "");
}

/**
 * Parses `--name-status -z`.
 *
 * Records are `status\0path\0`, except renames and copies which carry a score
 * and two paths: `R100\0old\0new\0`.
 */
function parseNameStatus(output: string): Array<Omit<DiffFile, "additions" | "deletions">> {
  const parts = tokens(output);
  const files: Array<Omit<DiffFile, "additions" | "deletions">> = [];

  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = statusFromCode(code);

    if (status === "renamed") {
      const oldPath = parts[i++];
      const path = parts[i++];
      if (path === undefined) break;
      files.push({ path, oldPath, status, binary: false });
    } else {
      const path = parts[i++];
      if (path === undefined) break;
      files.push({ path, status, binary: false });
    }
  }

  return files;
}

/**
 * Parses `--numstat -z` into per-path counts.
 *
 * The framing is not the same as `--name-status -z`. A normal record keeps the
 * path inside the token: `additions\tdeletions\tpath`. A rename leaves the path
 * field empty and follows with two separate tokens:
 *
 *     "2\t1\tkeep.txt"  "-\t-\tlogo.bin"  "0\t0\t" "rename-me.txt" "renamed.txt"
 *
 * so the empty third field is what marks a rename — no cross-reference with
 * `--name-status` is needed.
 */
function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = tokens(output);
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();

  for (let i = 0; i < parts.length; ) {
    const head = parts[i++];

    // Slice rather than split: a path may itself contain a tab, and only the
    // first two are field separators.
    const firstTab = head.indexOf("\t");
    const secondTab = head.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) break;

    const rawAdd = head.slice(0, firstTab);
    const rawDel = head.slice(firstTab + 1, secondTab);
    let path = head.slice(secondTab + 1);

    if (path === "") {
      // Rename: source token then destination token. Key on the destination,
      // which is what the file list shows.
      i += 1;
      const destination = parts[i++];
      if (destination === undefined) break;
      path = destination;
    }

    // Git writes "-" for both counts on binary files.
    const binary = rawAdd === "-" || rawDel === "-";
    counts.set(path, {
      additions: binary ? 0 : Number.parseInt(rawAdd, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(rawDel, 10) || 0,
      binary,
    });
  }

  return counts;
}

function range(baseBranch: string): string {
  return `origin/${baseBranch}...HEAD`;
}

/** Lists every file the task branch changed. */
export async function readDiffIndex(
  workspacePath: string,
  baseBranch: string,
): Promise<DiffIndex> {
  const git = simpleGit(workspacePath);
  const spec = range(baseBranch);

  const [nameStatus, numstat] = await Promise.all([
    git.raw(["diff", "-z", "--name-status", "--find-renames", spec]),
    git.raw(["diff", "-z", "--numstat", "--find-renames", spec]),
  ]);

  const entries = parseNameStatus(nameStatus);
  const counts = parseNumstat(numstat);

  const all: DiffFile[] = entries.map((entry) => {
    const count = counts.get(entry.path);
    return {
      ...entry,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
    };
  });

  const files = all.slice(0, MAX_FILES);
  return {
    baseBranch,
    files,
    truncated: all.length > MAX_FILES,
    totalAdditions: all.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: all.reduce((sum, file) => sum + file.deletions, 0),
  };
}

export type FilePatch = { path: string; patch: string; binary: boolean; truncated: boolean };

/**
 * Reads the unified diff for one file.
 *
 * `path` must already have been validated against {@link readDiffIndex} — see
 * the route handler. Passing an unvalidated path here would let a leading `-`
 * be read by git as an option.
 */
export async function readFilePatch(
  workspacePath: string,
  baseBranch: string,
  file: DiffFile,
): Promise<FilePatch> {
  if (file.binary) {
    return { path: file.path, patch: "", binary: true, truncated: false };
  }

  const git = simpleGit(workspacePath);
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const patch = await git.raw([
    "diff",
    "--find-renames",
    range(baseBranch),
    "--",
    ...paths,
  ]);

  const truncated = patch.length > MAX_PATCH_BYTES;
  return {
    path: file.path,
    patch: truncated
      ? `${patch.slice(0, MAX_PATCH_BYTES)}\n\n[... truncated, ${
          patch.length - MAX_PATCH_BYTES
        } more characters ...]`
      : patch,
    binary: false,
    truncated,
  };
}

/** One-line summary for the gate panel, e.g. "14 files changed, +320 −87". */
export function summarizeDiff(index: DiffIndex): string {
  const count = index.files.length;
  return (
    `${count} file${count === 1 ? "" : "s"} changed, ` +
    `+${index.totalAdditions} −${index.totalDeletions}`
  );
}
