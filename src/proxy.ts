import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { hasConfiguredTokens, verifyBearerToken } from "./server/auth/tokens";

/**
 * `spec-board-at-scale.md` §11.2 — gates `/api/*` behind an optional bearer
 * token.
 *
 * Named `proxy`, not `middleware`: this Next.js version renamed the file
 * convention and changed its default runtime (see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`,
 * "Migration to Proxy" — `middleware.ts` is deprecated in favour of this
 * file). Proxy defaults to the Node.js runtime here, which is what makes the
 * synchronous `better-sqlite3` lookups in `verifyBearerToken` safe to call
 * directly, with no edge-runtime workaround needed.
 *
 * When no token has ever been created, `hasConfiguredTokens()` is `false`
 * and every request passes through untouched — the API is exactly as open
 * as it was before this file existed. A local-first tool binding to
 * localhost should not require setup to work (§11.2).
 */
export const config = {
  matcher: ["/api/:path*"],
};

export function proxy(request: NextRequest): Response {
  if (!hasConfiguredTokens()) return NextResponse.next();

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const verified = match ? verifyBearerToken(match[1].trim()) : null;

  if (!verified) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handed to the route via a header rather than `AsyncLocalStorage` set
  // here: Proxy and the route handler it admits into are not guaranteed to
  // share one continuation, and Next's own guidance for passing information
  // downstream is headers, cookies, or the URL — not shared module state.
  // The route re-establishes the actor context from this header in its own
  // call stack; see `withActorFromRequest` in `server/auth/tokens.ts`.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("x-api-token-name", verified.name);
  return NextResponse.next({ request: { headers: forwardedHeaders } });
}
