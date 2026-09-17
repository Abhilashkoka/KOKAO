import { defineConfig } from "vitest/config";

/** Unit-only authorization checks: never boot test DB or provider credentials. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/videoGen/personalLikenessVideo.test.ts"],
    globalSetup: [],
    setupFiles: [],
    fileParallelism: false,
  },
});