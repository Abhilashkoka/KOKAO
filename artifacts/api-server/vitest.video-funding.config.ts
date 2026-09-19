import { defineConfig } from "vitest/config";

// Deliberately no shared API bootstrap: it mutates development billing settings.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/videoGen/funding.test.ts"],
    globalSetup: [],
    setupFiles: [],
  },
});