import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/settings/test-provider/route";

/**
 * Route-handler tests for `POST /api/settings/test-provider`, called
 * directly (pattern from `tests/settings.test.ts`). No database is involved
 * — `pingProvider` never touches the task/pipeline store — so unlike
 * `tests/settings.test.ts` this suite needs no temp `DATABASE_URL`.
 */

const originalEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
});

function post(body: unknown) {
  return POST(
    new Request("http://test/api/settings/test-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/settings/test-provider — validation", () => {
  it("rejects an unknown provider id with 400", async () => {
    const response = await post({ provider: "bard" });
    expect(response.status).toBe(400);
  });

  it("rejects a missing provider field with 400", async () => {
    const response = await post({});
    expect(response.status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const response = await POST(
      new Request("http://test/api/settings/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/settings/test-provider — missing credential", () => {
  it("returns 400 naming ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN for claude", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const response = await post({ provider: "claude" });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
  });

  it("returns 400 naming OPENAI_API_KEY for chatgpt", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await post({ provider: "chatgpt" });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/OPENAI_API_KEY/);
  });

  it("returns 400 naming GEMINI_API_KEY/GOOGLE_API_KEY for gemini", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const response = await post({ provider: "gemini" });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/GEMINI_API_KEY|GOOGLE_API_KEY/);
  });

  it("responds with well-formed JSON even on failure", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await post({ provider: "chatgpt" });
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    await expect(response.json()).resolves.toBeTruthy();
  });
});
