import { vacuumDatabase } from "@/server/db/client";
import { json, serverError } from "@/server/http/respond";

/**
 * `POST /api/settings/vacuum` — reclaims space the retention sweep freed.
 *
 * Explicit and separately triggered, never run by the sweep itself — see
 * `vacuumDatabase`'s own note on why this must never be on a timer.
 */
export async function POST() {
  try {
    vacuumDatabase();
    return json({ vacuumed: true });
  } catch (error) {
    return serverError(error);
  }
}
