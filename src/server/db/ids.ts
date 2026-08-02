import { randomUUID } from "node:crypto";

/** Prefixed, sortable-enough identifiers that read well in logs and URLs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Turns a task title into a branch-safe slug.
 *
 * Truncated to 40 characters so the full branch name stays comfortably within
 * git's limits even with the task id prefix.
 */
export function slugify(value: string, maxLength = 40): string {
  const slug = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug === "" ? "task" : slug;
}
