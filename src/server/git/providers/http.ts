/**
 * Shared HTTP plumbing for provider REST calls.
 *
 * The pipeline calls provider APIs directly rather than shelling out to `gh`,
 * `glab` or `az`: four CLIs is a worse dependency surface than four `fetch`
 * calls, and it keeps credentials out of subprocess environments.
 */

export class ProviderApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }
}

/** Guards against a hung provider taking a stage down with it. */
const REQUEST_TIMEOUT_MS = 15_000;

export type ProviderRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
};

/**
 * Pulls a human-readable message out of a provider's error body.
 *
 * Every provider nests it differently, and the raw JSON is not something to put
 * in front of a user.
 */
function extractMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim() !== "") return payload.slice(0, 400);
  if (payload === null || typeof payload !== "object") return fallback;

  const record = payload as Record<string, unknown>;
  for (const key of ["message", "error", "error_description", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.slice(0, 400);
  }

  // GitLab: { message: { base: ["..."] } }; Bitbucket: { error: { message } }.
  for (const key of ["message", "error", "errors"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const inner = extractMessage(nested, "");
      if (inner) return inner;
      const first = Object.values(nested as Record<string, unknown>)[0];
      if (Array.isArray(first) && typeof first[0] === "string") return first[0].slice(0, 400);
    }
  }

  return fallback;
}

/**
 * Performs a JSON request.
 *
 * @throws {ProviderApiError} on any non-2xx response or transport failure.
 */
export async function providerFetch<T>(request: ProviderRequest): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "all-my-fellas-pipeline",
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `the request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ProviderApiError(0, reason);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text === "" ? {} : JSON.parse(text);
  } catch {
    // Not JSON — keep the raw text for the error message.
  }

  if (!response.ok) {
    throw new ProviderApiError(
      response.status,
      extractMessage(payload, `${response.status} ${response.statusText}`),
    );
  }

  return payload as T;
}

/** `Authorization: Basic base64(user:secret)`. */
export function basicAuthHeader(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
}
