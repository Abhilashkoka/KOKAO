import { defineConfig } from "vitest/config";

/** Deliberately no DB schema or credentials setup: these are mocked boundary tests. */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/lib/likenessConsent.test.ts",
      "src/lib/imageGen/fallback.test.ts",
      "src/lib/imageGen/providers/replicate.personalReference.test.ts",
    ],
    fileParallelism: false,
  },
});