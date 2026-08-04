import { ZodError, type ZodType } from "zod";

/** Small helpers shared by the route handlers. */

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function badRequest(message: string, details?: unknown): Response {
  return Response.json({ error: message, details }, { status: 400 });
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404 });
}

export function conflict(message: string): Response {
  return Response.json({ error: message }, { status: 409 });
}

export function serverError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[api]", message);
  return Response.json({ error: message }, { status: 500 });
}

/**
 * Parses a JSON body against a schema.
 *
 * @returns the parsed value, or a `Response` to return directly on failure.
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequest("Request body must be valid JSON.") };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: badRequest("Invalid request payload.", flattenIssues(result.error)),
    };
  }
  return { ok: true, data: result.data };
}

/** Whether `request` carries a `multipart/form-data` body (i.e. has files attached). */
export function isMultipartRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").includes("multipart/form-data");
}

/**
 * Parses a `multipart/form-data` body's non-file fields against a schema.
 *
 * Mirrors {@link parseBody} for the multipart case: file fields (e.g.
 * `attachments`) are left in the returned `FormData` for the caller to read
 * with `getAll`, while every other field is coerced ("true"/"false" strings
 * to booleans, since HTML form values are always strings) and validated the
 * same way a JSON body would be.
 */
export async function parseMultipartFields<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<
  | { ok: true; data: T; formData: FormData }
  | { ok: false; response: Response }
> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, response: badRequest("Request body must be valid multipart form data.") };
  }

  const raw: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    raw[key] = value === "true" ? true : value === "false" ? false : value;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: badRequest("Invalid request payload.", flattenIssues(result.error)),
    };
  }
  return { ok: true, data: result.data, formData };
}

export function flattenIssues(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
