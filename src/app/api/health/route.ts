import { json, serverError } from "@/server/http/respond";
import { resolveWorkerHealth } from "@/server/worker/health";

/**
 * `GET /api/health` — the worker has no HTTP server of its own, so the web
 * process reports on it here by reading the heartbeat row it writes (§7.4).
 * Also what `docker-compose.yml`'s worker healthcheck hits, hence the
 * non-2xx status for anything that is not at least `lagging` — a
 * `never_started`/`stale` worker should fail a container healthcheck, not
 * pass it with a note.
 */
export async function GET() {
  try {
    const health = resolveWorkerHealth();
    const ok = health.state === "healthy" || health.state === "lagging";
    return json(health, { status: ok ? 200 : 503 });
  } catch (error) {
    return serverError(error);
  }
}
