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

export function flattenIssues(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
