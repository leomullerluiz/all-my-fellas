import { conflict, json, notFound, serverError } from "@/server/http/respond";
import {
  AttachmentNotFoundError,
  GateError,
  TaskNotFoundError,
  removeAttachment,
} from "@/server/pipeline/orchestrator";
import { getAttachment, getTask } from "@/server/tasks/service";

type Params = { id: string; attachmentId: string };

/** Strips characters that would break a `Content-Disposition` header value. */
function sanitizeFilenameFallback(filename: string): string {
  return filename.replace(/["\\\r\n]/g, "_");
}

/**
 * `GET /api/tasks/:id/attachments/:attachmentId` — downloads one attachment.
 *
 * Scoped to `id`: an attachment id that exists but belongs to another task is
 * treated the same as an unknown id, so a guessed id cannot fetch a file
 * across tasks.
 */
export async function GET(_request: Request, context: { params: Promise<Params> }) {
  try {
    const { id, attachmentId } = await context.params;
    const attachment = getAttachment(attachmentId);
    if (!attachment || attachment.taskId !== id) {
      return notFound(`Attachment ${attachmentId} not found.`);
    }

    const fallback = sanitizeFilenameFallback(attachment.filename);
    const encoded = encodeURIComponent(attachment.filename);

    return new Response(new Uint8Array(attachment.data), {
      status: 200,
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(attachment.sizeBytes),
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      },
    });
  } catch (error) {
    return serverError(error);
  }
}

/** `DELETE /api/tasks/:id/attachments/:attachmentId` — removes one attachment. */
export async function DELETE(_request: Request, context: { params: Promise<Params> }) {
  try {
    const { id, attachmentId } = await context.params;
    if (!getTask(id)) return notFound(`Task ${id} not found.`);

    removeAttachment(id, attachmentId);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof TaskNotFoundError) return notFound(error.message);
    if (error instanceof AttachmentNotFoundError) return notFound(error.message);
    if (error instanceof GateError) return conflict(error.message);
    return serverError(error);
  }
}
