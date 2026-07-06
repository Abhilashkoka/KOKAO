import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // These are real-DB integration tests that share a single global
    // app_credentials "meta" row. Run files serially so they don't race each
    // other on that shared row.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
