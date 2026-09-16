import { assertRequiredEnv } from "./lib/assertEnv";
import { initializeProductionCreditBootstrap } from "./lib/productionCreditBootstrap";

// This entrypoint intentionally has no app, route, or worker imports. Several
// runtime modules create rate-limiters and background timers while evaluating,
// so they must not be evaluated until the production data gate has committed.
assertRequiredEnv();
await initializeProductionCreditBootstrap();

// Keep the build entrypoint stable while deferring all runtime imports until
// after the startup-only production bootstrap above.
const { startServerRuntime } = await import("./serverRuntime");
await startServerRuntime();
