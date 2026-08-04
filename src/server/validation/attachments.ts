import { badRequest } from "../http/respond";

/**
 * Files a task description may carry alongside its text. Kept narrow (images
 * plus the three structured/document formats the brief names) rather than
 * accepting arbitrary uploads.
 */
export const ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "application/xml",
  "text/xml",
] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

function isAttachmentMimeType(value: string): value is AttachmentMimeType {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}

export type ValidatedAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
};

/**
 * Validates and reads a batch of uploaded files.
 *
 * Fails closed on the first problem found — naming the offending file — so an
 * upload either creates every attachment or none of them, never a partial set.
 */
export async function validateAttachmentFiles(
  files: File[],
): Promise<{ ok: true; data: ValidatedAttachment[] } | { ok: false; response: Response }> {
  const validated: ValidatedAttachment[] = [];

  for (const file of files) {
    if (!file.name) {
      return { ok: false, response: badRequest("One of the uploaded files has no filename.") };
    }
    if (file.size === 0) {
      return { ok: false, response: badRequest(`"${file.name}" is empty.`) };
    }
    if (!isAttachmentMimeType(file.type)) {
      return {
        ok: false,
        response: badRequest(
          `"${file.name}" has an unsupported type (${file.type || "unknown"}).`,
        ),
      };
    }

    validated.push({
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
  }

  return { ok: true, data: validated };
}
