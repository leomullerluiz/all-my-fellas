import { ActivityFeed, type ActivityEntry } from "@/components/activity-feed";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { listRecentEvents } from "@/server/events/store";
import { getTask } from "@/server/tasks/service";

export const dynamic = "force-dynamic";

/**
 * `/activity` — S6 §6.3's cross-task activity feed. Reachable independently
 * of the board; removing it leaves the per-task board and per-task SSE
 * stream (`/api/tasks/:id/stream`) unaffected — neither is touched here.
 */
export default async function ActivityPage() {
  const events = listRecentEvents(undefined, 100);

  // One `getTask` per distinct task in this page's initial 100-row window,
  // not per event — a title lookup for the RSC paint only, unrelated to the
  // board's per-render cost (§9.1).
  const titleById = new Map<string, string>();
  for (const event of events) {
    if (titleById.has(event.taskId)) continue;
    titleById.set(event.taskId, getTask(event.taskId)?.title ?? event.taskId);
  }

  const initial: ActivityEntry[] = events.map((event) => ({
    id: event.id,
    taskId: event.taskId,
    taskTitle: titleById.get(event.taskId) ?? event.taskId,
    createdAt: event.createdAt,
    payload: event.payload,
    actor: event.actor,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="max-h-[calc(100vh-14rem)] overflow-auto rounded-md border border-border bg-background p-3">
          <ActivityFeed initial={initial} />
        </div>
      </CardBody>
    </Card>
  );
}
