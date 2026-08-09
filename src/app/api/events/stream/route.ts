import { readEventsSince } from "@/server/events/store";

/**
 * `GET /api/events/stream` — Server-Sent Events tail of the event log across
 * every task (§8.2), not just one. A user on the board should hear about a
 * gate opening on a task they are not currently looking at; the per-task
 * route at `/api/tasks/:id/stream` cannot do that by design.
 *
 * Same polling/cursor mechanics as the per-task route, cursored on
 * `events.id` (a genuinely global key) instead of the per-task `seq`. This is
 * also what `spec-board-at-scale.md` §5's activity feed is meant to reuse.
 */

const POLL_INTERVAL_MS = 700;
const KEEPALIVE_INTERVAL_MS = 15_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lastEventId = request.headers.get("last-event-id") ?? url.searchParams.get("after");
  let cursor = Number.parseInt(lastEventId ?? "0", 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {
          // The client already went away; nothing to clean up.
        }
      };

      const poll = () => {
        if (closed) return;
        try {
          const batch = readEventsSince(cursor);
          for (const event of batch) {
            cursor = event.id;
            send(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
                id: event.id,
                taskId: event.taskId,
                seq: event.seq,
                stageRunId: event.stageRunId,
                createdAt: event.createdAt,
                payload: event.payload,
              })}\n\n`,
            );
          }
        } catch (error) {
          send(
            `event: error\ndata: ${JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
            })}\n\n`,
          );
          shutdown();
        }
      };

      send(`retry: 3000\n\n`);
      poll();

      // Unlike the per-task stream, this one never has a natural "done"
      // state — there is always another task that might produce an event —
      // so it stays open until the client disconnects.
      const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
      const keepaliveTimer = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_INTERVAL_MS);

      request.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
