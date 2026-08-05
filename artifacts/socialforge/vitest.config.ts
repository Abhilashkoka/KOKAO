import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Full validation runs execute several suites in parallel; the 5s default
    // times out healthy jsdom tests under that load (they pass in isolation).
    testTimeout: 20000,
    include: ["src/**/*.test.{ts,tsx}"],
    globalSetup: ["src/test/globalSetup.ts"],
    // Validation runs the whole monorepo's suites in parallel; under that load
    // the default 5s per-test timeout flakes on otherwise-passing UI tests.
    testTimeout: 20000,
  },
});
