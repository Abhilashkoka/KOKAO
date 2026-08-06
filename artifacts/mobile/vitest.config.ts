import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "react-native": "react-native-web",
      "@": path.resolve(import.meta.dirname),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Full-repo validation runs suites in parallel; jsdom tests flake on the
    // 5s default under that load (same pin the web artifact uses).
    testTimeout: 20000,
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
