import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // `environmentMatchGlobs` was removed in Vitest 4; component tests opt
    // into jsdom individually with a `// @vitest-environment jsdom` docblock
    // instead, so the rest of the suite keeps the faster `node` default.
    //
    // One worker per core is slower here than half that, and flaky with it.
    // These files are import-heavy — Next.js server modules, `better-sqlite3`,
    // real `git` child processes — so past a point the workers mostly contend
    // for the same disk and CPU. On an 8-core machine the full suite went from
    // intermittent 5s/10s timeouts to 65 files green, and finished sooner.
    // A fraction rather than a number so CI and larger machines scale with it.
    maxWorkers: "50%",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
