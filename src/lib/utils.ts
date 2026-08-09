import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional class names with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `$0.0421` — costs here are usually fractions of a cent. */
export function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** `1.2 MB` — for attachment sizes, which range from a few bytes to tens of MB. */
export function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st` — for a queue position. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function formatDuration(startedAt: number | null, finishedAt: number | null): string {
  if (!startedAt) return "—";
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Whole seconds until `retryAt`, floored at zero.
 *
 * A plain function rather than an inline `Date.now()` call in a component
 * body: React's purity rule flags the latter as an impure render, the same
 * way {@link formatDuration} already sidesteps it for a running stage's
 * elapsed time. The board re-renders on its own 4-second poll (`AutoRefresh`),
 * so a stale value here self-corrects on the next tick.
 */
export function retryCountdownSeconds(retryAt: number): number {
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}
