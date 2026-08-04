import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // `environmentMatchGlobs` was removed in Vitest 4; component tests opt
    // into jsdom individually with a `// @vitest-environment jsdom` docblock
    // instead, so the rest of the suite keeps the faster `node` default.
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
