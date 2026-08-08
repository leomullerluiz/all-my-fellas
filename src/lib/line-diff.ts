/**
 * Line-level diff between two artifact versions, computed in the browser.
 *
 * Artifacts are capped at `MAX_ARTIFACT_CHARS` (40 000 characters — see
 * `pipeline/artifacts.ts`), so a line-level LCS over roughly 1 000 × 1 000
 * lines is a single-digit-millisecond operation — cheap enough that neither a
 * diff library nor a server round trip over data the client already holds is
 * worth it. See spec-audit-trail.md §7.
 *
 * The output is a synthetic unified-patch-shaped string (` context`, `+added`,
 * `-removed`, one line per array element) that `PatchBody` renders unchanged,
 * inheriting its gutter markers and no-raw-HTML guarantee.
 */
export function diffLines(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  // Longest-common-subsequence table, built bottom-up so the trace below can
  // walk forward from (0, 0).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    lines.push(`-${a[i]}`);
    i++;
  }
  while (j < m) {
    lines.push(`+${b[j]}`);
    j++;
  }

  return lines.join("\n");
}
