"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Periodically re-fetches the current server-rendered route.
 *
 * The board has no per-task SSE connection — refreshing the RSC payload on an
 * interval is enough to keep it live without opening a socket per card.
 */
export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
