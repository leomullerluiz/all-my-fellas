import { describe, expect, it } from "vitest";

import {
  buildGateNotificationCopy,
  canShowBrowserNotifications,
  createCursorGate,
  isApprovalGateOpened,
  type StreamEnvelope,
} from "@/lib/gate-notifications";
import { GATES } from "@/server/pipeline/stages";
import { PIPELINE_EVENT_TYPES, type PipelineEvent } from "@/server/events/types";

/**
 * S1 — one `gate_opened`-into-an-approval-gate event should notify exactly
 * once; everything else (other event types, other stages, replays, and
 * events already covered by a persisted cursor) should not.
 */

function envelope(payload: PipelineEvent, id = 1): StreamEnvelope {
  return { id, taskId: "task_1", seq: 1, stageRunId: null, createdAt: 0, payload };
}

/** One minimal, valid payload per `PipelineEvent["type"]`, for the "every other type" AC. */
const SAMPLE_PAYLOAD_BY_TYPE: Record<PipelineEvent["type"], PipelineEvent> = {
  task_created: { type: "task_created", title: "t" },
  task_started: { type: "task_started" },
  task_edited: { type: "task_edited", fields: ["title"] },
  stage_started: { type: "stage_started", stage: "DEVELOPMENT", attempt: 1 },
  stage_finished: { type: "stage_finished", stage: "DEVELOPMENT", attempt: 1, costUsd: 0 },
  stage_failed: { type: "stage_failed", stage: "DEVELOPMENT", attempt: 1, error: "boom" },
  agent_text: { type: "agent_text", text: "hi" },
  agent_thinking: { type: "agent_thinking" },
  agent_tool_use: { type: "agent_tool_use", tool: "bash", summary: "ls" },
  agent_tool_denied: { type: "agent_tool_denied", tool: "bash", reason: "no" },
  artifact_saved: { type: "artifact_saved", artifactType: "plan" },
  gate_opened: { type: "gate_opened", gate: "PLAN_GATE" },
  gate_decided: { type: "gate_decided", gate: "PLAN_GATE", decision: "approve" },
  git: { type: "git", message: "pushed" },
  pr_opened: { type: "pr_opened", url: "https://example.com/pr/1" },
  task_finished: { type: "task_finished", stage: "COMPLETED" },
  log: { type: "log", level: "info", message: "hi" },
  verification_started: { type: "verification_started", commands: ["build"] },
  verification_command_started: { type: "verification_command_started", kind: "build", command: "npm run build" },
  verification_output: { type: "verification_output", kind: "build", stream: "stdout", chunk: "ok" },
  verification_command_finished: {
    type: "verification_command_finished",
    kind: "build",
    exitCode: 0,
    durationMs: 10,
    timedOut: false,
  },
  verification_finished: { type: "verification_finished", status: "passed" },
  quota_warning: { type: "quota_warning", usedUsd: 1, limitUsd: 2, cadence: "daily" },
  quota_overridden: { type: "quota_overridden", usedUsd: 1, limitUsd: 2, cadence: "daily" },
};

describe("isApprovalGateOpened", () => {
  it("is true for gate_opened on each of the three approval gates", () => {
    for (const gate of GATES) {
      expect(isApprovalGateOpened(envelope({ type: "gate_opened", gate }))).toBe(true);
    }
  });

  it("is false for gate_opened on a non-gate stage (defensive — should never occur upstream)", () => {
    expect(isApprovalGateOpened(envelope({ type: "gate_opened", gate: "VERIFICATION" }))).toBe(
      false,
    );
  });

  it("is false for every event type other than gate_opened", () => {
    for (const type of PIPELINE_EVENT_TYPES) {
      if (type === "gate_opened") continue;
      expect(isApprovalGateOpened(envelope(SAMPLE_PAYLOAD_BY_TYPE[type]))).toBe(false);
    }
  });
});

describe("buildGateNotificationCopy", () => {
  it("includes the task title and the phrase 'awaiting your approval'", () => {
    const { title, body } = buildGateNotificationCopy("Fix the login bug");
    const combined = `${title} ${body}`;
    expect(combined).toContain("Fix the login bug");
    expect(combined).toContain("awaiting your approval");
  });
});

describe("canShowBrowserNotifications", () => {
  it("is true only when the setting is on and permission is granted", () => {
    expect(canShowBrowserNotifications(true, "granted")).toBe(true);
  });

  it("is false when the setting is off, regardless of permission", () => {
    expect(canShowBrowserNotifications(false, "granted")).toBe(false);
  });

  it("is false when permission is denied or default, regardless of the setting", () => {
    expect(canShowBrowserNotifications(true, "denied")).toBe(false);
    expect(canShowBrowserNotifications(true, "default")).toBe(false);
    expect(canShowBrowserNotifications(true, undefined)).toBe(false);
  });
});

describe("createCursorGate", () => {
  it("advances on a new, higher id and reports it as new", () => {
    const gate = createCursorGate(0);
    expect(gate.advance(5)).toBe(true);
    expect(gate.value).toBe(5);
  });

  it("does not re-advance on the same id delivered twice (SSE reconnect replay)", () => {
    const gate = createCursorGate(0);
    expect(gate.advance(5)).toBe(true);
    expect(gate.advance(5)).toBe(false);
    expect(gate.value).toBe(5);
  });

  it("treats an id at or below a seeded cursor as already processed (reload)", () => {
    const gate = createCursorGate(10);
    expect(gate.advance(10)).toBe(false);
    expect(gate.advance(3)).toBe(false);
    expect(gate.value).toBe(10);
  });
});
