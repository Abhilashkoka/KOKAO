import { defineConfig } from "vitest/config";
import { configureTestDatabase } from "./src/test-database";

configureTestDatabase();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Fail fast with a clear "run db push" message when the dev DB schema
    // has drifted from lib/db/src/schema/ (e.g. after a merge).
    globalSetup: ["./src/test-database.ts", "./src/test-schema-check.ts"],
    // Suites share singleton fixtures within their isolated cluster.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
