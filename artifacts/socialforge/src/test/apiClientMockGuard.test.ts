import { describe, expect, it } from "vitest";
import {
  buildOffenderMessage,
  findMockGuardOffenders,
  MOCK_TARGET,
} from "./apiClientMockGuardCheck";

/**
 * Guard: every test that mocks `@workspace/api-client-react` must build the
 * mock through the shared resilient helper (`createApiClientMock` from
 * `src/test/apiClientMock.ts`).
 *
 * The actual check lives in `apiClientMockGuardCheck.ts` and ALSO runs from
 * vitest globalSetup (see `globalSetup.ts`), so it still executes when tests
 * run selectively and this file is filtered out.
 */
describe("api-client-react mock guard", () => {
  it(`every vi.mock of ${MOCK_TARGET} goes through createApiClientMock`, () => {
    const offenders = findMockGuardOffenders();
    expect(offenders, buildOffenderMessage(offenders)).toEqual([]);
  });
});
