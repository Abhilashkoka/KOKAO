import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/lib/videoGen/directedVideo.test.ts"], testTimeout: 30000 } });