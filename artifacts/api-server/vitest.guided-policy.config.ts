import { defineConfig } from "vitest/config";

// Pure policy tests: no database, provider calls, or shared-credential setup.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/videoGen/guidedScenePolicy.test.ts"],
  },
});
