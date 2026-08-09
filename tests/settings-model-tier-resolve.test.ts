import { describe, expect, it } from "vitest";

import { resolveModelId, tierModels } from "@/server/config/llm-providers";

/**
 * stories.md S3 — a stage stores a tier (or a literal), resolved into the
 * literal id a provider needs only at execution time. This is what makes
 * switching a role's provider keep the role runnable without editing the
 * model field: the same `{ tier: "default" }` selection resolves to a
 * different, valid id per provider.
 */

describe("resolveModelId", () => {
  it("resolves a tier to the right literal per provider", () => {
    const table = tierModels();
    expect(resolveModelId("claude", { tier: "default" })).toBe(table.claude.default);
    expect(resolveModelId("chatgpt", { tier: "default" })).toBe(table.chatgpt.default);
    expect(resolveModelId("gemini", { tier: "default" })).toBe(table.gemini.default);
  });

  it("switching a role's provider with a tier selected resolves to a different, valid id", () => {
    const selection = { tier: "default" as const };
    const claudeId = resolveModelId("claude", selection);
    const geminiId = resolveModelId("gemini", selection);
    expect(claudeId).not.toBe(geminiId);
    expect(geminiId).toBe(tierModels().gemini.default);
  });

  it("a literal selection resolves to itself regardless of provider", () => {
    expect(resolveModelId("chatgpt", { literal: "custom-model-id" })).toBe("custom-model-id");
    expect(resolveModelId("claude", { literal: "custom-model-id" })).toBe("custom-model-id");
  });

  it("every tier for every provider is a non-empty string", () => {
    const table = tierModels();
    for (const provider of Object.keys(table) as Array<keyof typeof table>) {
      for (const tier of Object.keys(table[provider]) as Array<keyof (typeof table)[typeof provider]>) {
        expect(table[provider][tier].length).toBeGreaterThan(0);
      }
    }
  });
});
