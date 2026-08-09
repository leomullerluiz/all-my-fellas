import type { StageRunExportRow } from "../tasks/service";

/**
 * RFC 4180 CSV rendering for the stage-run export (stories.md S5).
 *
 * Kept separate from `service.ts` (SQL only) and the route (HTTP only) so the
 * escaping rule can be unit tested without a database.
 */

const HEADER = [
  "task_id",
  "task_title",
  "repo",
  "stage",
  "attempt",
  "provider",
  "model",
  "started_at",
  "finished_at",
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "cost_usd",
  "status",
] as const;

/**
 * RFC 4180 field escaping: a field containing a comma, a double quote or a
 * newline is wrapped in `"..."`, with any internal `"` doubled. `null`/
 * `undefined` render as the empty field, not the literal string `"null"`.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsvRow(fields: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return fields.map(csvField).join(",");
}

/** One row per `stage_runs` row, CRLF-terminated per RFC 4180, header first. */
export function stageRunsToCsv(rows: StageRunExportRow[]): string {
  const lines = [toCsvRow(HEADER)];
  for (const row of rows) {
    lines.push(
      toCsvRow([
        row.taskId,
        row.taskTitle,
        row.repo,
        row.stage,
        row.attempt,
        row.provider,
        row.model,
        row.startedAt,
        row.finishedAt,
        row.inputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.outputTokens,
        row.costUsd,
        row.status,
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
