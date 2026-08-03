import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored verbatim from the Animate UI registry so it stays diffable
    // against upstream. Lint it on their terms, not ours.
    "src/components/animate-ui/**",
    "src/hooks/**",
    "src/lib/get-strict-context.tsx",
  ]),
]);

export default eslintConfig;
