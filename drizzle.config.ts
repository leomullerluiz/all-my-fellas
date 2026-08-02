import { defineConfig } from "drizzle-kit";

import { resolveDatabaseFile } from "./src/server/config/env";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDatabaseFile(),
  },
});
