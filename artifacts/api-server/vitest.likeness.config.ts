import { defineConfig } from "vitest/config";

/**
 * Deliberately no DB schema setup: these are mocked boundary tests.
 *
 * likenessProviderPolicy.test.ts imports the real provider registries in order
 * to assert that every catalogued provider has a reviewed likeness position, so
 * the module-load env guards of those adapters need placeholder values. No
 * provider is ever called.
 */
export default defineConfig({
  test: {
    environment: "node",
    env: {
      AI_INTEGRATIONS_OPENAI_BASE_URL: "http://localhost:0/unused",
      AI_INTEGRATIONS_OPENAI_API_KEY: "unused",
    },
    include: [
      "src/lib/likenessConsent.test.ts",
      "src/lib/likenessProviderPolicy.test.ts",
      "src/lib/imageGen/fallback.test.ts",
      "src/lib/imageGen/providers/replicate.personalReference.test.ts",
    ],
    fileParallelism: false,
  },
});
