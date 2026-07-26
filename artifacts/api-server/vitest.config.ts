import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Fail fast with a clear "run db push" message when the dev DB schema
    // has drifted from lib/db/src/schema/ (e.g. after a merge).
    globalSetup: ["./src/test-schema-check.ts", "./src/test-credentials-guard.ts"],
    // These are real-DB integration tests that share a single global
    // app_credentials "meta" row. Run files serially so they don't race each
    // other on that shared row.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
