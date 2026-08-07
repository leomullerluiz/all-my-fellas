import { describe, expect, it } from "vitest";

import {
  createRepoSchema,
  updateVerificationCommandsSchema,
} from "@/server/validation/schemas";

/** Pure `zod` validation for the verification command fields — no DB, no route. */

const VALID_BODY = {
  name: "acme/app",
  url: "https://github.com/acme/app",
  defaultBranch: "main",
};

describe("createRepoSchema — verification fields", () => {
  it("accepts a plain command", () => {
    const result = createRepoSchema.safeParse({ ...VALID_BODY, verifyBuild: "npm run build" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.verifyBuild).toBe("npm run build");
  });

  it("accepts a command with flags and spaces", () => {
    const result = createRepoSchema.safeParse({ ...VALID_BODY, verifyTest: "poetry run pytest -q" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.verifyTest).toBe("poetry run pytest -q");
  });

  it("normalises an empty string to undefined", () => {
    const result = createRepoSchema.safeParse({ ...VALID_BODY, verifyInstall: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.verifyInstall).toBeUndefined();
  });

  it.each([
    ["a && b", "a && b"],
    ["a | b", "a | b"],
    ["a; b", "a; b"],
    ["backticks", "echo `whoami`"],
    ["command substitution", "echo $(whoami)"],
    ["a newline", "a\nb"],
    ["a redirect", "echo hi > out.txt"],
  ])("rejects shell syntax: %s", (_label, command) => {
    const result = createRepoSchema.safeParse({ ...VALID_BODY, verifyBuild: command });
    expect(result.success).toBe(false);
  });

  it("rejects a command over 500 characters", () => {
    const result = createRepoSchema.safeParse({
      ...VALID_BODY,
      verifyBuild: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a timeout outside [30, 3600]", () => {
    expect(
      createRepoSchema.safeParse({ ...VALID_BODY, verifyTimeoutSeconds: 29 }).success,
    ).toBe(false);
    expect(
      createRepoSchema.safeParse({ ...VALID_BODY, verifyTimeoutSeconds: 3601 }).success,
    ).toBe(false);
    expect(
      createRepoSchema.safeParse({ ...VALID_BODY, verifyTimeoutSeconds: 600 }).success,
    ).toBe(true);
  });
});

describe("updateVerificationCommandsSchema", () => {
  it("accepts a partial update with just one field", () => {
    const result = updateVerificationCommandsSchema.safeParse({ verifyLint: "npm run lint" });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (no-op update)", () => {
    expect(updateVerificationCommandsSchema.safeParse({}).success).toBe(true);
  });

  it("rejects any field outside the five verification fields", () => {
    const result = updateVerificationCommandsSchema.safeParse({
      verifyInstall: "npm ci",
      url: "https://github.com/acme/hijacked",
    });
    expect(result.success).toBe(false);
  });

  it("rejects credentialRef even alone", () => {
    const result = updateVerificationCommandsSchema.safeParse({
      credentialRef: "GITHUB_TOKEN",
    });
    expect(result.success).toBe(false);
  });
});
