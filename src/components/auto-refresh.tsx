"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Periodically re-fetches the current server-rendered route.
 *
 * The board has no per-task SSE connection — refreshing the RSC payload on an
 * interval is enough to keep it live without opening a socket per card.
 *
 * S5 (`spec-board-at-scale.md` §9.2) adds two cheap improvements: the timer
 * pauses while the tab is hidden (a background tab otherwise polls forever),
 * and the caller can pass a slower `intervalMs` once nothing on the board is
 * actually live — see `page.tsx`'s backoff computation, driven by
 * `settings.boardRefreshMs`.
 */
export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        // A hidden tab may have missed several ticks — catch up immediately
        // on return rather than waiting up to a full `intervalMs` for the
        // first refresh.
        router.refresh();
        start();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, intervalMs]);

  return null;
}
