/**
 * Pattern-based secret redaction for transcripts and prompts.
 *
 * See `spec-audit-trail.md` §10. This is defence in depth, not a guarantee:
 * a high-entropy value under a name this module does not recognise
 * (`clientAuth`, `dsn`, `conn`) is not caught, and a credential written in
 * prose is not caught either. The honest claim is "the shapes we know are
 * masked" — stated here once rather than re-derived at each call site.
 *
 * `redactRemote` (`../../git/workspace.ts`) already covers the two URL/header
 * credential shapes it needs for scrubbing git error messages; this module
 * extends that coverage rather than replacing it, so both keep working
 * independently.
 */

export type RedactionResult = { text: string; hits: number };

/**
 * Applies `pattern` to `text`, counting how many times `replacer` ran.
 *
 * `replacer` receives the full match first, then each capture group —
 * `String.replace`'s own callback shape, minus the trailing offset and whole
 * string it also passes.
 */
function replaceCounting(
  text: string,
  pattern: RegExp,
  replacer: (...match: string[]) => string,
): RedactionResult {
  let hits = 0;
  const replaced = text.replace(pattern, (...args) => {
    hits++;
    const groups = args.slice(0, -2) as string[];
    return replacer(...groups);
  });
  return { text: replaced, hits };
}

/**
 * Credential-shaped variable name, matched case-insensitively. The prefix and
 * suffix are both optional so a bare `PASSWORD` matches, not just a name that
 * merely contains it (`DB_PASSWORD`, `PASSWORD_HASH`).
 */
const SECRET_NAME = "[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)[A-Za-z0-9_]*";

/**
 * This module's own output shape (`API_KEY=[redacted:32 chars]`,
 * `"password": "[redacted:14 chars]"`). Both value alternatives below exclude
 * it via a leading negative lookahead so a second pass — read-time redaction
 * over text a write-time pass already redacted — is a no-op rather than a
 * corrupting re-match: `\S+` would otherwise stop at the space inside the
 * marker and redact `[redacted:32` a second time, leaving `chars]` stranded.
 */
const ALREADY_REDACTED = "\\[redacted:";

const ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_NAME})\\s*=\\s*(?!${ALREADY_REDACTED})("[^"\\n]*"|'[^'\\n]*'|\\S+)`,
  "gi",
);

const JSON_PAIR_PATTERN = new RegExp(
  `"(${SECRET_NAME})"\\s*:\\s*"(?!${ALREADY_REDACTED})([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`,
  "gi",
);

/** Known token prefixes: GitHub, GitLab, Slack, OpenAI-shaped, AWS access keys. */
const TOKEN_PATTERN =
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9\-_]{15,}|xoxb-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b/g;

const PEM_PATTERN = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

/** `redactRemote`'s two shapes, duplicated here so this module can count hits. */
const REMOTE_CREDENTIAL_PATTERN = /https:\/\/[^@\s/]+:[^@\s/]+@/g;
const AUTH_HEADER_PATTERN = /(Authorization:\s*Basic\s+)\S+/gi;

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Redacts every known secret shape from `text`, preserving the surrounding
 * key/shape so a reader knows something was there — never a silent deletion.
 */
export function redactSecrets(text: string): RedactionResult {
  let hits = 0;
  let current = text;

  let step = replaceCounting(current, REMOTE_CREDENTIAL_PATTERN, () => "https://***@");
  current = step.text;
  hits += step.hits;

  step = replaceCounting(current, AUTH_HEADER_PATTERN, (_match, prefix) => `${prefix}***`);
  current = step.text;
  hits += step.hits;

  step = replaceCounting(current, PEM_PATTERN, (match) => `[redacted: PEM block, ${match.length} chars]`);
  current = step.text;
  hits += step.hits;

  step = replaceCounting(
    current,
    JSON_PAIR_PATTERN,
    (_match, name, value) => `"${name}": "[redacted:${value.length} chars]"`,
  );
  current = step.text;
  hits += step.hits;

  step = replaceCounting(current, ASSIGNMENT_PATTERN, (_match, name, rawValue) => {
    const value = stripQuotes(rawValue);
    return `${name}=[redacted:${value.length} chars]`;
  });
  current = step.text;
  hits += step.hits;

  step = replaceCounting(current, TOKEN_PATTERN, (match) => `[redacted:${match.length} chars]`);
  current = step.text;
  hits += step.hits;

  return { text: current, hits };
}
