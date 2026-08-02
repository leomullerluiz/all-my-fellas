import { readEvents } from "@/server/events/store";
import { getTask } from "@/server/tasks/service";

/**
 * `GET /api/tasks/:id/stream` — Server-Sent Events tail of the task's event log.
 *
 * The worker writes to the `events` table; this handler polls it and pushes new
 * rows to the browser. Polling a local SQLite table every 700 ms is cheap and
 * avoids adding a broker just to move a few hundred log lines.
 *
 * Resumable: the browser's `Last-Event-ID` header (sent automatically by
 * `EventSource` on reconnect) or a `?after=` query parameter sets the cursor.
 */

const POLL_INTERVAL_MS = 700;
const KEEPALIVE_INTERVAL_MS = 15_000;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  if (!getTask(id)) {
    return Response.json({ error: `Task ${id} not found.` }, { status: 404 });
  }

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
          const batch = readEvents(id, cursor);
          for (const event of batch) {
            cursor = event.seq;
            send(
              `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
                seq: event.seq,
                stageRunId: event.stageRunId,
                createdAt: event.createdAt,
                payload: event.payload,
              })}\n\n`,
            );
          }

          // Close the stream once the task is finished and fully drained, so
          // the browser stops holding a connection open forever.
          const task = getTask(id);
          const finished =
            task !== null &&
            ["completed", "rejected", "failed", "cancelled"].includes(task.status);
          if (finished && batch.length === 0) {
            send(`event: done\ndata: {}\n\n`);
            shutdown();
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
