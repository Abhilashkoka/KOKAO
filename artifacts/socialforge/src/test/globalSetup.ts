import { buildOffenderMessage, findMockGuardOffenders } from "./apiClientMockGuardCheck";

/**
 * Vitest globalSetup: runs once per vitest invocation, BEFORE any test file
 * filtering. This guarantees the api-client-react mock-safety check executes
 * even when tests run selectively (e.g. `vitest related` or a path filter
 * that would skip apiClientMockGuard.test.ts).
 */
export default function setup(): void {
  const offenders = findMockGuardOffenders();
  if (offenders.length > 0) {
    throw new Error(`api-client-react mock guard failed.\n${buildOffenderMessage(offenders)}`);
  }
}
