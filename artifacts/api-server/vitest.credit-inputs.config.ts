import { defineConfig } from "vitest/config";

// Deliberately no application bootstrap, live DB, rate-card writes or global setup.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/routes/characterFunding.isolated.test.ts",
      "src/lib/imageEdit.meter.test.ts",
      "src/lib/characterVisualQa.regression.test.ts",
    ],
    globalSetup: [],
    setupFiles: [],
    fileParallelism: false,
  },
});