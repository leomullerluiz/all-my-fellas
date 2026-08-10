import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { newId } from "../db/ids";
import { apiTokens } from "../db/schema";

/**
 * `spec-board-at-scale.md` §11 — an optional bearer token that unlocks
 * unattended access to `/api/*` (a CI trigger, approving a gate from a
 * phone). `src/proxy.ts` is the only caller that decides whether a request
 * gets in; this module owns hashing, verification, and the actor label a
 * token-authenticated action is recorded under.
 *
 * A label, not an identity (§11.3): a token has a `name`, and that name is
 * all `appendEvent` ever records — see `runWithActor`/`withActorFromRequest`
 * below.
 */

const SCRYPT_KEYLEN = 32;

/**
 * A fixed, published salt is safe here: the input is always a high-entropy
 * generated secret (`generateTokenSecret`), never a human-chosen password, so
 * there is no reused-password/rainbow-table risk a per-token salt would
 * guard against. What `scrypt` buys is a slow, non-reversible digest so a
 * leaked database row cannot be turned back into a working token.
 */
const TOKEN_HASH_SALT = "all-my-fellas-api-token-v1";

function hashToken(rawSecret: string): string {
  return scryptSync(rawSecret, TOKEN_HASH_SALT, SCRYPT_KEYLEN).toString("hex");
}

/** A high-entropy raw secret for a new token, hex-encoded. */
export function generateTokenSecret(): string {
  return randomBytes(32).toString("hex");
}

export type ApiTokenSummary = { id: string; name: string };

/**
 * Registers a token from its raw secret.
 *
 * The only place in the codebase that ever sees a raw secret alongside a
 * database write — it is hashed on the way in and the raw value is not
 * retained anywhere after this call returns. See `scripts/create-api-token.ts`,
 * the only script that calls this, for how an operator mints one without the
 * secret ever appearing in shell history (it is read from an environment
 * variable, following the `repos.credential_ref` precedent of naming rather
 * than storing a secret).
 */
export function createApiToken(name: string, rawSecret: string): ApiTokenSummary {
  const id = newId("tok");
  db.insert(apiTokens)
    .values({ id, name, tokenHash: hashToken(rawSecret) })
    .run();
  return { id, name };
}

/**
 * Whether any token has ever been created. When this is `false`, `/api/*`
 * stays exactly as open as it is without this feature — see `src/proxy.ts`.
 */
export function hasConfiguredTokens(): boolean {
  return db.select({ id: apiTokens.id }).from(apiTokens).limit(1).get() !== undefined;
}

/**
 * Verifies a raw bearer token against every configured token's hash, and
 * stamps `last_used_at` on a match.
 *
 * A linear scan rather than a hash-indexed lookup by design: `token_hash` is
 * itself the lookup key an attacker would need to forge, so comparing it
 * with `timingSafeEqual` rather than `WHERE token_hash = ?` avoids leaking
 * timing information through SQLite's own comparison — the number of
 * configured tokens is expected to be a handful (§11.3, a label per
 * automation), not a scale where this matters for latency.
 */
export function verifyBearerToken(rawSecret: string): ApiTokenSummary | null {
  const candidate = Buffer.from(hashToken(rawSecret), "hex");
  for (const row of db.select().from(apiTokens).all()) {
    const stored = Buffer.from(row.tokenHash, "hex");
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
      db.update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, row.id)).run();
      return { id: row.id, name: row.name };
    }
  }
  return null;
}

/**
 * Carries the name of the token that authenticated the current request, so
 * `appendEvent` can attribute an action without an `actor` parameter
 * threaded through every orchestrator function — see `techplan.md`'s "Two
 * deliberate rejections".
 */
const actorStorage = new AsyncLocalStorage<string>();

export function runWithActor<T>(name: string, fn: () => T): T {
  return actorStorage.run(name, fn);
}

/**
 * Runs `fn` with the actor context set from `x-api-token-name`, the header
 * `src/proxy.ts` sets once it has verified a bearer token. `Proxy` and the
 * route handler it admits are not guaranteed to share one continuation
 * (Next's own guidance is to pass information downstream via headers, not
 * shared module state) — reading the header back out inside the route
 * handler's own call stack is what makes `AsyncLocalStorage` reliable here.
 * A request with no such header (every browser-originated one, and every
 * request when no token is configured) runs unmodified.
 */
export function withActorFromRequest<T>(request: Request, fn: () => T): T {
  const actor = request.headers.get("x-api-token-name");
  return actor ? runWithActor(actor, fn) : fn();
}

export function getCurrentActor(): string | null {
  return actorStorage.getStore() ?? null;
}
