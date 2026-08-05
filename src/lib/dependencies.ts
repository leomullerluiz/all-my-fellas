/**
 * Shared "why can't I start this" copy for dependency blocks.
 *
 * Mirrors `capacityBlockedReason` (`src/lib/capacity.ts`), kept as a
 * separate function and a distinct message so the two independent gates
 * (admission control vs. prerequisites) never read as the same reason.
 */
export function dependencyBlockedReason(
  dependsOn: Array<{ title: string; status: string }>,
): string | null {
  const incomplete = dependsOn.filter((dependency) => dependency.status !== "completed");
  if (incomplete.length === 0) return null;

  const [first, ...rest] = incomplete;
  return (
    `Waiting on prerequisite task${incomplete.length === 1 ? "" : "s"} — "${first.title}"` +
    (rest.length > 0 ? ` and ${rest.length} more` : "") +
    ` ${incomplete.length === 1 ? "is" : "are"} not finished yet.`
  );
}
