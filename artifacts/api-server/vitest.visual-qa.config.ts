import { defineConfig } from "vitest/config";

/**
 * Pure visual-QA regression tests deliberately bypass the API test bootstrap.
 * They must not restore global AI settings or touch the shared database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/lib/characterVisualQa.regression.test.ts",
      "src/lib/characterVisualQa.test.ts",
    ],
    globalSetup: [],
    setupFiles: [],
    fileParallelism: false,
  },
});