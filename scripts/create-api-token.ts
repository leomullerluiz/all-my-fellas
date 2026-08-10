import "dotenv/config";

import { closeDatabase } from "../src/server/db/client";
import { createApiToken, generateTokenSecret } from "../src/server/auth/tokens";

/**
 * `npm run token:create -- --name=CI [--secret-env=CI_API_TOKEN_SECRET]` —
 * `spec-board-at-scale.md` §11.2.
 *
 * The raw secret never reaches the database — only its hash does (see
 * `createApiToken`). Two ways to provide it, both keeping the value out of
 * shell history and out of this process's argv:
 *
 * - `--secret-env=NAME` reads the already-generated secret from that
 *   environment variable (the `repos.credential_ref` precedent: the operator
 *   names where the value lives, this script never stores the name itself).
 * - Omitted, the script generates one and prints it exactly once — the
 *   operator's only chance to copy it into wherever they intend to keep it
 *   (a CI secret store, a password manager). It is not recoverable after
 *   this process exits: only `token_hash` survives in the database.
 */

function parseArgs(argv: string[]): { name?: string; secretEnv?: string } {
  const result: { name?: string; secretEnv?: string } = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (key === "name") result.name = value;
    if (key === "secret-env") result.secretEnv = value;
  }
  return result;
}

function main(): void {
  const { name, secretEnv } = parseArgs(process.argv.slice(2));
  if (!name) {
    console.error("Usage: npm run token:create -- --name=<label> [--secret-env=<ENV_VAR_NAME>]");
    process.exitCode = 1;
    return;
  }

  let rawSecret = secretEnv ? process.env[secretEnv] : undefined;
  let generated = false;
  if (!rawSecret) {
    rawSecret = generateTokenSecret();
    generated = true;
  }

  const token = createApiToken(name, rawSecret);

  if (generated) {
    console.log(`Generated a new secret for token "${token.name}" (id ${token.id}).`);
    console.log("This is the only time it is shown — the database stores only its hash:");
    console.log(`\n  ${rawSecret}\n`);
    console.log('Send it as `Authorization: Bearer <secret>` on requests to /api/*.');
  } else {
    console.log(`Registered token "${token.name}" (id ${token.id}) from $${secretEnv}.`);
  }
}

main();
closeDatabase();
