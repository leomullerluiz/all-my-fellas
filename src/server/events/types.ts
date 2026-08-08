import type { LlmProviderId } from "../config/llm-providers";
import type { Stage } from "../pipeline/stages";

/**
 * The event vocabulary, split out from `store.ts` deliberately.
 *
 * `store.ts` imports `db` (`better-sqlite3`, a native Node addon), which
 * cannot be bundled for the browser. `LiveLog` — a client component — only
 * ever needed the *types* here, which is why importing `PipelineEvent` from
 * `store.ts` was always safe: a type-only import is erased before bundling.
 * `PIPELINE_EVENT_TYPES` is a runtime value, though, and re-exporting it
 * through `store.ts` would drag the whole DB client into the client bundle.
 * This module has no server-only imports at all, so it is safe to import
 * directly from a client component; `store.ts` re-exports everything here
 * for the modules that already import it as a single source.
 */

/** The four commands the `VERIFICATION` stage can run, in execution order. */
export type VerificationKind = "install" | "build" | "test" | "lint";

export type PipelineEvent =
  | { type: "task_created"; title: string }
  | { type: "task_started" }
  /** Field names only — the current values already live on the task row. */
  | { type: "task_edited"; fields: string[] }
  | { type: "stage_started"; stage: Stage; attempt: number; model?: string; provider?: LlmProviderId }
  | { type: "stage_finished"; stage: Stage; attempt: number; costUsd: number }
  | { type: "stage_failed"; stage: Stage; attempt: number; error: string }
  | { type: "agent_text"; text: string }
  | { type: "agent_thinking" }
  | { type: "agent_tool_use"; tool: string; summary: string }
  | { type: "agent_tool_denied"; tool: string; reason: string }
  | { type: "artifact_saved"; artifactType: string }
  | { type: "gate_opened"; gate: Stage }
  | { type: "gate_decided"; gate: Stage; decision: string; comment?: string }
  /**
   * `gate` would otherwise have parked the task waiting for a human, but the
   * "no-approval automation" setting was on — see `state-machine.ts`'s
   * `bypassedGate`. Never written for the silent
   * `autoApprovePlanForLowCriticality` waiver, only for this setting.
   */
  | { type: "gate_bypassed"; gate: Stage }
  | { type: "git"; message: string }
  // `noun` is absent on rows written before this field existed; readers fall
  // back to the neutral "change request" — see `NEUTRAL_CHANGE_REQUEST_NOUN`.
  | { type: "pr_opened"; url: string; noun?: string }
  | { type: "task_finished"; stage: Stage; reason?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  /** What the `VERIFICATION` stage is about to run, before anything spawns. */
  | { type: "verification_started"; commands: VerificationKind[] }
  | { type: "verification_command_started"; kind: VerificationKind; command: string }
  /** Buffered — see `runVerification`'s flush interval, not one event per line. */
  | { type: "verification_output"; kind: VerificationKind; stream: "stdout" | "stderr"; chunk: string }
  | {
      type: "verification_command_finished";
      kind: VerificationKind;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
    }
  | {
      type: "verification_finished";
      status: "passed" | "failed" | "skipped" | "errored";
      reason?: string;
    };

/**
 * Every `PipelineEvent` variant's `type`, derived from the union rather than
 * hand-maintained. Consumers that dispatch or subscribe per event name (the
 * SSE route, `LiveLog`) iterate this instead of their own list, so a new
 * variant added above cannot compile while still being unreachable in the UI
 * — the exact gap a hand-maintained array left open for the five variants
 * this type was introduced for.
 *
 * `Record<PipelineEvent["type"], true>` rather than a plain `as const` array:
 * a mapped-type `Record` over a literal union desugars to one required
 * property per member, so `satisfies` rejects both a missing and an
 * extraneous key at compile time — a plain array assertion only catches the
 * "extra" direction.
 */
const PIPELINE_EVENT_TYPE_SET = {
  task_created: true,
  task_started: true,
  task_edited: true,
  stage_started: true,
  stage_finished: true,
  stage_failed: true,
  agent_text: true,
  agent_thinking: true,
  agent_tool_use: true,
  agent_tool_denied: true,
  artifact_saved: true,
  gate_opened: true,
  gate_decided: true,
  gate_bypassed: true,
  git: true,
  pr_opened: true,
  task_finished: true,
  log: true,
  verification_started: true,
  verification_command_started: true,
  verification_output: true,
  verification_command_finished: true,
  verification_finished: true,
} satisfies Record<PipelineEvent["type"], true>;

export const PIPELINE_EVENT_TYPES = Object.keys(
  PIPELINE_EVENT_TYPE_SET,
) as PipelineEvent["type"][];
