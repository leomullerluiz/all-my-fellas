import { PRIORITIES, type Priority } from "@/server/pipeline/stages";

/**
 * Autosave for the create-mode New Task form (`stories.md` S1–S3). Kept out
 * of `new-task-form.tsx` so the storage shape, parsing and `try/catch`
 * guarding can be unit tested against jsdom's real `localStorage` — see
 * `tests/new-task-draft.test.ts`.
 *
 * `localStorage`, not `sessionStorage`: S2 requires the draft to survive a
 * full tab close and reopen in a brand-new tab, which `sessionStorage` does
 * not support.
 *
 * Deliberately excludes `pendingFiles`/`existingAttachments` — files are
 * never serialized into the draft, by construction rather than by filtering.
 * Same `try/catch`-everywhere posture as `gate-approval-notifier.tsx`'s
 * cursor helpers, the only prior use of browser storage in this codebase: a
 * blocked storage API (private browsing, quota, disabled cookies) degrades
 * to "no autosave" rather than taking the form down.
 */

const DRAFT_STORAGE_KEY = "new-task-form:draft";

export type NewTaskDraft = {
  repoId?: string;
  title?: string;
  branchName?: string;
  description?: string;
  priority?: Priority;
  requireHumanCodeReview?: boolean;
  /** Stored as the raw input string (including ""), matching the form's own state. */
  maxCostPerTaskUsd?: string;
};

function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

/**
 * Defensive per-field validation: an unrecognized shape (malformed JSON
 * already handled by the caller, a wrong-typed field, a value from a future
 * or older version of this draft) drops just that field rather than
 * discarding the whole draft or throwing.
 */
export function parseNewTaskDraft(value: unknown): NewTaskDraft {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const draft: NewTaskDraft = {};

  if (typeof raw.repoId === "string") draft.repoId = raw.repoId;
  if (typeof raw.title === "string") draft.title = raw.title;
  if (typeof raw.branchName === "string") draft.branchName = raw.branchName;
  if (typeof raw.description === "string") draft.description = raw.description;
  if (isPriority(raw.priority)) draft.priority = raw.priority;
  if (typeof raw.requireHumanCodeReview === "boolean") {
    draft.requireHumanCodeReview = raw.requireHumanCodeReview;
  }
  if (typeof raw.maxCostPerTaskUsd === "string") draft.maxCostPerTaskUsd = raw.maxCostPerTaskUsd;

  return draft;
}

/** `null` on missing, malformed, or inaccessible storage — never throws. */
export function readNewTaskDraft(): NewTaskDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw === null) return null;
    return parseNewTaskDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeNewTaskDraft(draft: NewTaskDraft): void {
  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Nothing to persist to — the field just isn't autosaved this session.
  }
}

export function clearNewTaskDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Best-effort — see the doc comment above.
  }
}
