import { describe, expect, it } from "vitest";

import { redactSecrets } from "@/server/pipeline/audit/redact";

/**
 * S2 — secret redaction, applied before a transcript or prompt reaches
 * storage, and again on read for rows written before this feature existed.
 */

describe("redactSecrets", () => {
  it.each([
    ["ghp_" + "a".repeat(36)],
    ["github_pat_" + "b".repeat(30)],
    ["glpat-" + "c".repeat(20)],
    ["xoxb-" + "1".repeat(12)],
    ["sk-" + "d".repeat(24)],
    ["AKIA" + "0".repeat(16)],
  ])("redacts the known token prefix %s", (token) => {
    const { text, hits } = redactSecrets(`Found a leaked token: ${token} in the commit.`);
    expect(hits).toBeGreaterThan(0);
    expect(text).not.toContain(token);
  });

  it("redacts a NAME=value assignment while keeping the key", () => {
    const { text, hits } = redactSecrets("API_KEY=abcdef0123456789abcdef0123456789");
    expect(hits).toBe(1);
    expect(text).toContain("API_KEY=[redacted:32 chars]");
    expect(text).not.toContain("abcdef0123456789abcdef0123456789");
  });

  it("redacts a JSON name/value pair while keeping the key", () => {
    const { text, hits } = redactSecrets('{"password": "hunter2hunter2"}');
    expect(hits).toBe(1);
    expect(text).toContain('"password": "[redacted:14 chars]"');
    expect(text).not.toContain("hunter2hunter2");
  });

  it("redacts a PEM private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAK...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, hits } = redactSecrets(`key:\n${pem}\nend`);
    expect(hits).toBe(1);
    expect(text).not.toContain("MIIBOgIBAAJBAK");
    expect(text).toContain("[redacted: PEM block");
  });

  it("keeps redactRemote's two existing shapes working", () => {
    const { text: urlText, hits: urlHits } = redactSecrets(
      "fatal: could not read https://user:s3cr3t@github.com/acme/app.git",
    );
    expect(urlHits).toBe(1);
    expect(urlText).toContain("https://***@github.com/acme/app.git");
    expect(urlText).not.toContain("s3cr3t");

    const { text: headerText, hits: headerHits } = redactSecrets(
      "Authorization: Basic dXNlcjpwYXNz",
    );
    expect(headerHits).toBe(1);
    expect(headerText).toBe("Authorization: Basic ***");
  });

  it("does not redact a base64-looking value under an unrecognised key name", () => {
    // The deliberate negative case (spec §10.3): the shapes we know are
    // masked, and nothing stronger is claimed.
    const { text, hits } = redactSecrets('{"clientAuth": "aGVsbG93b3JsZGJhc2U2NHN0cmluZ2V4YW1wbGU="}');
    expect(hits).toBe(0);
    expect(text).toContain("aGVsbG93b3JsZGJhc2U2NHN0cmluZ2V4YW1wbGU=");
  });

  it("does not redact ordinary text with no secret shape", () => {
    const { text, hits } = redactSecrets("Read src/server/config/env.ts and ran npm test.");
    expect(hits).toBe(0);
    expect(text).toBe("Read src/server/config/env.ts and ran npm test.");
  });

  it("is idempotent over an assignment it already redacted", () => {
    // A prompt/transcript is redacted once at write time (execute.ts,
    // saveTranscript) and again at read time (the transcript route) for rows
    // that predate write-time redaction. A second pass over the first pass's
    // own output must be a no-op, not a corrupting re-match.
    const once = redactSecrets("API_KEY=abcdef0123456789abcdef0123456789");
    const twice = redactSecrets(once.text);
    expect(twice.hits).toBe(0);
    expect(twice.text).toBe(once.text);
    expect(twice.text).toContain("API_KEY=[redacted:32 chars]");
  });

  it("is idempotent over a JSON pair it already redacted", () => {
    const once = redactSecrets('{"password": "hunter2hunter2"}');
    const twice = redactSecrets(once.text);
    expect(twice.hits).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it("redacts a JSON pair whose value contains an escaped quote without the match spilling past the escape boundary", () => {
    // `saveTranscript` redacts the *serialised* transcript string (§10.2's
    // risk note): a secret value containing a literal `"` is escaped as `\"`
    // inside that JSON. The value group must stop at the real closing quote,
    // not the escaped one.
    const serialised = String.raw`{"apiKey": "abc\"def0123456789ghijkl", "next": "unrelated"}`;
    const { text, hits } = redactSecrets(serialised);
    expect(hits).toBe(1);
    expect(text).not.toContain("def0123456789ghijkl");
    expect(text).toContain('"next": "unrelated"');
    // The redacted value stays valid JSON: exactly one closing quote before the comma.
    expect(text).toMatch(/"apiKey": "\[redacted:\d+ chars\]", "next": "unrelated"/);
  });

  it("redacts a secret shape reached through both the write-time and read-time call sites without corrupting it", () => {
    // Mirrors the real pipeline path: `saveTranscript`/`execute.ts` redact at
    // write time, and the transcript route redacts again at read time so
    // rows written before this feature existed are still covered.
    const raw = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx and nothing else.";
    const writeTime = redactSecrets(raw);
    const readTime = redactSecrets(writeTime.text);
    expect(readTime.text).toBe(writeTime.text);
    expect(readTime.text).not.toContain("chars] chars]");
    expect(readTime.text).not.toMatch(/\]\s+chars\]/);
  });
});
