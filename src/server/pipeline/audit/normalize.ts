import type { LlmProviderId } from "../../config/llm-providers";

/**
 * Renders the three providers' stored `transcript_json` shapes through one
 * view model, on read. Storage does not change — `transcript_json` stays a
 * provider-specific `unknown[]`; this is the conversion the viewer and the
 * export read through. See spec-audit-trail.md §5.
 */

export type TranscriptRole = "system" | "assistant" | "tool" | "user" | "result";
export type TranscriptKind = "text" | "thinking" | "tool_use" | "tool_result" | "meta" | "result";

export type TranscriptEntry = {
  /** 0-based position in the stored array; stable, and the pagination cursor. */
  index: number;
  role: TranscriptRole;
  kind: TranscriptKind;
  /** Rendered body. Redaction happens at write time and again on read (§10). */
  text?: string;
  /** `input` is the full input, not a truncated summary string. */
  tool?: { name: string; input?: unknown; output?: string; isError?: boolean };
  usage?: { inputTokens: number; outputTokens: number };
  /** Set when the element did not match any known shape; `text` holds the raw JSON. */
  unrecognised?: true;
};

export type NormalizedTranscript = {
  provider: LlmProviderId | "unknown";
  entries: TranscriptEntry[];
  /** True when the write-time cap or the retention sweep removed content. */
  truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extracts plain text from an Anthropic-shaped block or block array. */
function textFromBlockContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .filter((text) => text !== "")
      .join("\n");
  }
  return "";
}

class EntryCollector {
  readonly entries: TranscriptEntry[] = [];

  push(entry: Omit<TranscriptEntry, "index">): void {
    this.entries.push({ index: this.entries.length, ...entry });
  }

  /** Every element the mapper does not recognise, kept rather than dropped. */
  pushUnrecognised(role: TranscriptRole, raw: unknown): void {
    this.push({ role, kind: "meta", text: JSON.stringify(raw), unrecognised: true });
  }
}

// ---- Claude ---------------------------------------------------------------

/** One `SDKMessage` per stream frame — see `providers/claude.ts`. */
function mapClaude(raw: unknown[]): TranscriptEntry[] {
  const collector = new EntryCollector();
  const toolNameById = new Map<string, string>();

  for (const message of raw) {
    if (!isRecord(message)) {
      collector.pushUnrecognised("system", message);
      continue;
    }

    const type = message.type;

    if (type === "system") {
      const subtype = typeof message.subtype === "string" ? message.subtype : "unknown";
      collector.push({ role: "system", kind: "meta", text: `System event: ${subtype}` });
      continue;
    }

    if (type === "assistant") {
      const content = isRecord(message.message) ? message.message.content : undefined;
      if (!Array.isArray(content)) {
        collector.pushUnrecognised("assistant", message);
        continue;
      }
      for (const block of content) {
        if (!isRecord(block)) {
          collector.pushUnrecognised("assistant", block);
          continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim() !== "") collector.push({ role: "assistant", kind: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          collector.push({ role: "assistant", kind: "thinking", text: block.thinking });
        } else if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "unknown";
          if (typeof block.id === "string") toolNameById.set(block.id, name);
          collector.push({ role: "assistant", kind: "tool_use", tool: { name, input: block.input } });
        } else {
          collector.pushUnrecognised("assistant", block);
        }
      }
      continue;
    }

    if (type === "user") {
      const content = isRecord(message.message) ? message.message.content : undefined;
      if (!Array.isArray(content)) {
        collector.pushUnrecognised("user", message);
        continue;
      }
      for (const block of content) {
        if (!isRecord(block)) {
          collector.pushUnrecognised("user", block);
          continue;
        }
        if (block.type === "tool_result") {
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
          collector.push({
            role: "tool",
            kind: "tool_result",
            tool: {
              name: (toolUseId && toolNameById.get(toolUseId)) || "unknown",
              output: textFromBlockContent(block.content),
              isError: block.is_error === true,
            },
          });
        } else if (block.type === "text" && typeof block.text === "string") {
          collector.push({ role: "user", kind: "text", text: block.text });
        } else {
          collector.pushUnrecognised("user", block);
        }
      }
      continue;
    }

    if (type === "result") {
      const usage = isRecord(message.usage) ? message.usage : undefined;
      collector.push({
        role: "result",
        kind: "result",
        text: typeof message.result === "string" ? message.result : undefined,
        usage: usage
          ? {
              inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
              outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
            }
          : undefined,
      });
      continue;
    }

    // Every other Claude SDK message type (status, hook, retry, rate-limit,
    // ...) is plumbing this viewer has no rendering for — kept, not dropped.
    collector.pushUnrecognised("system", message);
  }

  return collector.entries;
}

// ---- OpenAI -----------------------------------------------------------------

/**
 * The accumulated chat-completions `messages` array — the full conversation
 * (`providers/openai.ts`'s own `transcript`, see §12.3): `system`, `user`,
 * each `assistant` turn, and each `tool` result.
 */
function mapOpenAi(raw: unknown[]): TranscriptEntry[] {
  const collector = new EntryCollector();
  const toolNameByCallId = new Map<string, string>();

  for (const message of raw) {
    if (!isRecord(message)) {
      collector.pushUnrecognised("system", message);
      continue;
    }

    const role = message.role;

    if (role === "system") {
      collector.push({ role: "system", kind: "meta", text: typeof message.content === "string" ? message.content : "" });
      continue;
    }

    if (role === "user") {
      collector.push({ role: "user", kind: "text", text: typeof message.content === "string" ? message.content : "" });
      continue;
    }

    if (role === "assistant") {
      if (typeof message.content === "string" && message.content.trim() !== "") {
        collector.push({ role: "assistant", kind: "text", text: message.content });
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        if (!isRecord(call) || !isRecord(call.function)) {
          collector.pushUnrecognised("assistant", call);
          continue;
        }
        const name = typeof call.function.name === "string" ? call.function.name : "unknown";
        if (typeof call.id === "string") toolNameByCallId.set(call.id, name);
        let input: unknown = call.function.arguments;
        if (typeof call.function.arguments === "string") {
          try {
            input = JSON.parse(call.function.arguments);
          } catch {
            // Malformed JSON from the model — keep the raw string rather than crash.
            input = call.function.arguments;
          }
        }
        collector.push({ role: "assistant", kind: "tool_use", tool: { name, input } });
      }
      continue;
    }

    if (role === "tool") {
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
      collector.push({
        role: "tool",
        kind: "tool_result",
        tool: {
          name: (callId && toolNameByCallId.get(callId)) || "unknown",
          output: typeof message.content === "string" ? message.content : "",
        },
      });
      continue;
    }

    collector.pushUnrecognised("system", message);
  }

  return collector.entries;
}

// ---- Gemini -----------------------------------------------------------------

/**
 * The accumulated `contents` array — the full conversation (§12.3): the
 * initial user prompt, each model turn, and each function-call result.
 */
function mapGemini(raw: unknown[]): TranscriptEntry[] {
  const collector = new EntryCollector();

  for (const content of raw) {
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      collector.pushUnrecognised("system", content);
      continue;
    }

    const role: TranscriptRole = content.role === "model" ? "assistant" : "user";

    for (const part of content.parts) {
      if (!isRecord(part)) {
        collector.pushUnrecognised(role, part);
        continue;
      }
      if (typeof part.text === "string" && part.text.trim() !== "") {
        collector.push({ role, kind: "text", text: part.text });
      } else if (isRecord(part.functionCall)) {
        collector.push({
          role,
          kind: "tool_use",
          tool: { name: typeof part.functionCall.name === "string" ? part.functionCall.name : "unknown", input: part.functionCall.args },
        });
      } else if (isRecord(part.functionResponse)) {
        const response = part.functionResponse.response;
        const output = isRecord(response) && typeof response.output === "string" ? response.output : JSON.stringify(response ?? null);
        collector.push({
          role: "tool",
          kind: "tool_result",
          tool: { name: typeof part.functionResponse.name === "string" ? part.functionResponse.name : "unknown", output },
        });
      } else {
        collector.pushUnrecognised(role, part);
      }
    }
  }

  return collector.entries;
}

// ---- Sniffing (rows written before `stage_runs.provider` existed) --------

/**
 * Recognises `capTranscript`'s own marker (`service.ts`'s `{ truncated: true,
 * reason: "…" }`), written into the array in place of the entries it dropped.
 * Detected here rather than trusted only via the `truncated` parameter, since
 * a caller that forgets to pass it (or a row where retention appended a
 * marker of its own) must still surface as truncated rather than silently not.
 */
function isTruncationMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.truncated === true &&
    typeof value.reason === "string" &&
    Object.keys(value).length === 2
  );
}

function sniffProvider(raw: unknown[]): LlmProviderId | "unknown" {
  const first = raw.find((entry) => isRecord(entry)) as Record<string, unknown> | undefined;
  if (!first) return "unknown";

  if (typeof first.type === "string" && ["system", "assistant", "user", "result"].includes(first.type)) {
    return "claude";
  }
  if ("parts" in first && "role" in first) return "gemini";
  if ("role" in first && ("content" in first || "tool_calls" in first)) return "chatgpt";
  return "unknown";
}

/**
 * Maps a stored `transcript_json` array to the normalised view model.
 *
 * @param provider `stage_runs.provider` (§4). `null` for a row written before
 *   that column existed, which falls back to sniffing the shape.
 * @param raw The parsed `transcript_json` value.
 * @param truncated Whether the write-time cap or the retention sweep already
 *   removed content from this transcript, before it ever reached this module.
 */
export function normalizeTranscript(
  provider: LlmProviderId | null,
  raw: unknown,
  truncated = false,
): NormalizedTranscript {
  if (!Array.isArray(raw)) {
    return { provider: provider ?? "unknown", entries: [], truncated };
  }

  const resolved = provider ?? sniffProvider(raw);

  const entries =
    resolved === "claude"
      ? mapClaude(raw)
      : resolved === "chatgpt"
        ? mapOpenAi(raw)
        : resolved === "gemini"
          ? mapGemini(raw)
          : raw.map((entry, index) => ({ index, role: "system" as const, kind: "meta" as const, text: JSON.stringify(entry), unrecognised: true as const }));

  const markerPresent = raw.some(isTruncationMarker);

  return { provider: resolved, entries, truncated: truncated || markerPresent };
}
