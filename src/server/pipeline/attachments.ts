import { PDFParse } from "pdf-parse";

import type { RoleDefinition } from "../agents/roles";
import type { AttachmentRow } from "../db/schema";
import { type AttachmentMeta, getAttachment, listAttachments } from "../tasks/service";
import { truncateForPrompt } from "./prompt";

/**
 * Attachments as prompt input.
 *
 * `role.attachments` (`agents/roles.ts`) decides who gets what; this module
 * turns the task's stored files into the same `supplements` shape the branch
 * diff already uses (`prompt.ts`'s `StagePromptInput.supplements`), so no new
 * seam is needed for the text-shaped kinds — see stories.md S1.
 *
 * Images are deliberately out of scope here (stories.md S5): they cannot
 * travel as a string supplement and need a native content block per
 * provider. This module only ever skips them, never drops them silently —
 * that is left to whatever handles `StagePromptInput.media` once it exists.
 */

export type PromptSupplement = { label: string; body: string; fenced?: boolean };

/** Per-attachment cap: 200 KB of extracted text before truncation. */
export const MAX_ATTACHMENT_CHARS = 200_000;
/** Per-stage cap across every attachment's combined extracted text. */
export const MAX_STAGE_ATTACHMENT_CHARS = 500_000;

const TEXT_MIME_TYPES = new Set(["application/json", "application/xml", "text/xml"]);
const PDF_MIME_TYPE = "application/pdf";

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extracts inlinable text from a non-image attachment.
 *
 * @returns the text, or `null` when the file could not be read as text (a
 *   malformed PDF, most likely) — the caller announces this rather than
 *   silently dropping the attachment.
 */
async function extractText(attachment: AttachmentRow): Promise<string | null> {
  if (TEXT_MIME_TYPES.has(attachment.mimeType)) {
    return attachment.data.toString("utf8");
  }

  if (attachment.mimeType === PDF_MIME_TYPE) {
    const parser = new PDFParse({ data: attachment.data });
    try {
      const result = await parser.getText();
      return result.text;
    } catch {
      return null;
    } finally {
      await parser.destroy();
    }
  }

  return null;
}

/**
 * Builds the attachment supplements for one stage's prompt.
 *
 * Text kinds (JSON, XML, extracted PDF text) only — images are skipped here,
 * never dropped: see the module doc comment. Returns `[]` for `role.attachments
 * === "none"` and for a task with no attachments, so a task with nothing
 * attached produces no "Attachments" section at all.
 */
export async function buildAttachmentSupplements(
  taskId: string,
  role: RoleDefinition,
): Promise<PromptSupplement[]> {
  if (role.attachments === "none") return [];

  const metas = listAttachments(taskId);
  if (metas.length === 0) return [];

  const supplements: PromptSupplement[] = [];
  const omittedForSize: AttachmentMeta[] = [];
  let usedChars = 0;

  for (const meta of metas) {
    if (isImage(meta.mimeType)) continue;

    const full = getAttachment(meta.id);
    if (!full) continue;

    const text = await extractText(full);
    if (text === null) {
      supplements.push({
        label: `Attachment: ${meta.filename}`,
        body: `(${formatSize(meta.sizeBytes)}, could not be read as text — omitted)`,
      });
      continue;
    }

    if (usedChars >= MAX_STAGE_ATTACHMENT_CHARS) {
      omittedForSize.push(meta);
      continue;
    }

    const truncated = truncateForPrompt(text, MAX_ATTACHMENT_CHARS);
    usedChars += truncated.length;
    supplements.push({
      label: `Attachment: ${meta.filename}`,
      body: truncated,
      fenced: true,
    });
  }

  if (omittedForSize.length > 0) {
    supplements.push({
      label: "Attachments omitted for size",
      body: [
        `The remaining attachments were omitted from this prompt because the stage's ` +
          `combined attachment text would otherwise exceed ${formatSize(MAX_STAGE_ATTACHMENT_CHARS)}:`,
        "",
        ...omittedForSize.map((meta) => `- ${meta.filename} (${formatSize(meta.sizeBytes)})`),
      ].join("\n"),
    });
  }

  return supplements;
}
