import { describe, expect, it } from "vitest";

import { normalizeTranscript } from "@/server/pipeline/audit/normalize";

/**
 * S3 — the transcript normaliser: one view model over Claude's, OpenAI's and
 * Gemini's stored shapes (`stage_runs.provider`-driven, with a sniffing
 * fallback for rows written before that column existed).
 */

describe("normalizeTranscript — claude", () => {
  const fixture = [
    { type: "system", subtype: "init", session_id: "sess_1" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking at the file now." },
          { type: "thinking", thinking: "I should check the config first." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/a.ts" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "1\texport const a = 1;", is_error: false }],
      },
    },
    {
      type: "result",
      subtype: "success",
      result: "done",
      usage: { input_tokens: 120, output_tokens: 40 },
    },
  ];

  it("maps init to meta, blocks to their kinds, and the tool_result back to its tool_use's name", () => {
    const { provider, entries, truncated } = normalizeTranscript("claude", fixture);

    expect(provider).toBe("claude");
    expect(truncated).toBe(false);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "meta",
      "text",
      "thinking",
      "tool_use",
      "tool_result",
      "result",
    ]);

    const toolUse = entries.find((entry) => entry.kind === "tool_use");
    expect(toolUse?.tool).toMatchObject({ name: "Read", input: { file_path: "src/a.ts" } });

    const toolResult = entries.find((entry) => entry.kind === "tool_result");
    expect(toolResult?.tool).toMatchObject({ name: "Read", output: "1\texport const a = 1;", isError: false });

    const result = entries.find((entry) => entry.kind === "result");
    expect(result?.text).toBe("done");
    expect(result?.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("keeps an unrecognised element instead of dropping it", () => {
    const { entries } = normalizeTranscript("claude", [{ type: "some_future_frame", weird: true }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].unrecognised).toBe(true);
    expect(entries[0].text).toContain("some_future_frame");
  });

  it("indexes entries 0-based and stable across the array", () => {
    const { entries } = normalizeTranscript("claude", fixture);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("normalizeTranscript — openai", () => {
  const fixture = [
    { role: "system", content: "You are the Developer." },
    { role: "user", content: "## Task\n..." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "1\tcontent" },
    { role: "assistant", content: "## Report\nDone." },
  ];

  it("maps content to text, tool_calls to tool_use with parsed arguments", () => {
    const { provider, entries } = normalizeTranscript("chatgpt", fixture);
    expect(provider).toBe("chatgpt");

    const toolUse = entries.find((entry) => entry.kind === "tool_use");
    expect(toolUse?.tool).toMatchObject({ name: "Read", input: { file_path: "a.ts" } });

    const toolResult = entries.find((entry) => entry.kind === "tool_result");
    expect(toolResult?.tool).toMatchObject({ name: "Read", output: "1\tcontent" });

    const texts = entries.filter((entry) => entry.kind === "text").map((entry) => entry.text);
    expect(texts).toContain("## Task\n...");
    expect(texts).toContain("## Report\nDone.");
  });

  it("keeps a malformed tool_calls arguments string as raw text instead of crashing", () => {
    const broken = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_x", type: "function", function: { name: "Read", arguments: "{not json" } }],
      },
    ];
    const { entries } = normalizeTranscript("chatgpt", broken);
    const toolUse = entries.find((entry) => entry.kind === "tool_use");
    expect(toolUse?.tool?.input).toBe("{not json");
  });
});

describe("normalizeTranscript — gemini", () => {
  const fixture = [
    { role: "user", parts: [{ text: "## Task\n..." }] },
    { role: "model", parts: [{ functionCall: { name: "Read", args: { file_path: "a.ts" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "Read", response: { output: "1\tcontent" } } }] },
    { role: "model", parts: [{ text: "## Report\nDone." }] },
  ];

  it("maps parts.text and functionCall/functionResponse", () => {
    const { provider, entries } = normalizeTranscript("gemini", fixture);
    expect(provider).toBe("gemini");

    const toolUse = entries.find((entry) => entry.kind === "tool_use");
    expect(toolUse?.tool).toMatchObject({ name: "Read", input: { file_path: "a.ts" } });
    expect(toolUse?.role).toBe("assistant");

    const toolResult = entries.find((entry) => entry.kind === "tool_result");
    expect(toolResult?.tool).toMatchObject({ name: "Read", output: "1\tcontent" });
  });
});

describe("normalizeTranscript — provider fallback", () => {
  it("sniffs a Claude-shaped array and reports the resolved provider, not 'unknown'", () => {
    const { provider } = normalizeTranscript(null, [{ type: "result", subtype: "success", result: "x" }]);
    expect(provider).toBe("claude");
  });

  it("reports 'unknown' rather than an empty transcript when sniffing fails", () => {
    const { provider, entries } = normalizeTranscript(null, [{ mystery: true }]);
    expect(provider).toBe("unknown");
    expect(entries).toHaveLength(1);
    expect(entries[0].unrecognised).toBe(true);
  });
});
