import { createHmac } from "node:crypto";

import { eq } from "drizzle-orm";

import { resolveAppUrl } from "../config/env";
import { db } from "../db/client";
import { repos, tasks } from "../db/schema";
import type { PipelineEvent } from "../events/types";
import type { Stage } from "../pipeline/stages";
import { getSettings } from "../settings/store";

/**
 * Outbound webhook dispatch (§8) — one `POST` per notifiable event, reaching
 * Slack, Discord, ntfy, n8n, Zapier or a user's own script without a
 * per-vendor integration (§8.3).
 *
 * Called by `appendEvent` *after* its transaction commits, never from inside
 * one — an outbound HTTP call inside a SQLite write transaction shared by two
 * processes is how `SQLITE_BUSY` becomes a product feature (§8.1). This is
 * deliberately the only call site: every future notifiable moment should
 * reach here by going through `appendEvent`, not by calling this directly.
 */

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 3_000];

export type WebhookBody = {
  event: string;
  taskId: string;
  taskTitle: string;
  repo: string;
  stage: Stage | null;
  url: string;
  at: number;
};

/** Pulls a `Stage`/`Gate` out of whichever field the event variant carries, if any. */
function stageForEvent(payload: PipelineEvent): Stage | null {
  if ("stage" in payload) return payload.stage;
  if ("gate" in payload) return payload.gate;
  return null;
}

function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function postOnce(url: string, body: string, headers: Record<string, string>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Webhook responded ${response.status} ${response.statusText}.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget delivery: up to {@link MAX_ATTEMPTS} tries with backoff, a
 * failure logged and swallowed rather than thrown — a broken webhook must
 * never fail or block the pipeline (§8's stated invariant).
 */
async function deliver(url: string, body: string, headers: Record<string, string>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await postOnce(url, body, headers);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS) {
        console.error(`[notifications] webhook delivery failed after ${MAX_ATTEMPTS} attempts: ${message}`);
        return;
      }
      console.warn(`[notifications] webhook attempt ${attempt} failed, retrying: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt - 1]));
    }
  }
}

/**
 * Dispatches `payload` for `taskId`'s event, if a webhook is configured and
 * this event type is enabled (§8.4). Never throws — `appendEvent` calls this
 * without awaiting it for exactly that reason.
 */
export async function dispatchNotification(taskId: string, payload: PipelineEvent): Promise<void> {
  const { notifications } = getSettings();
  if (!notifications.webhookUrl) return;
  if (notifications.events[payload.type] !== true) return;

  const row = db
    .select({ title: tasks.title, repoName: repos.name })
    .from(tasks)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return;

  const body: WebhookBody = {
    event: payload.type,
    taskId,
    taskTitle: row.title,
    repo: row.repoName,
    stage: stageForEvent(payload),
    url: `${resolveAppUrl()}/tasks/${taskId}`,
    at: Date.now(),
  };

  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (notifications.webhookSecretRef) {
    const secret = process.env[notifications.webhookSecretRef];
    if (secret) headers["X-Signature"] = signBody(raw, secret);
  }

  await deliver(notifications.webhookUrl, raw, headers);
}
