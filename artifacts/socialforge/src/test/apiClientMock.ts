import { vi } from "vitest";

/**
 * Resilient mock for `@workspace/api-client-react`.
 *
 * Page tests used to hand-list every generated hook in a `vi.mock` factory.
 * Every time a page imported a new hook, the mock silently went stale and
 * unrelated tests failed with "No <hook> export is defined". This helper
 * returns a Proxy module namespace instead: known overrides win, and every
 * unknown export gets a sensible default so new hooks never break existing
 * tests.
 *
 * Defaults for unknown exports:
 * - `use*`          -> idle hook result ({ mutate, mutateAsync, isPending:
 *                      false, data: undefined, isLoading: false, ... }) that
 *                      works as either a mutation or a query stub
 * - `get*QueryKey`  -> () => [<export name>]
 * - anything else   -> a vi.fn() (call-able, resolves to undefined)
 *
 * Plus real-shaped defaults for the non-generated utility exports
 * (`isRestartRejection`, `RESTART_RETRY_DELAY_MS`, `mutateWithRestartRetry`).
 *
 * Usage (the factory must import lazily because `vi.mock` is hoisted):
 *
 *   vi.mock("@workspace/api-client-react", async () => {
 *     const { createApiClientMock } = await import("../test/apiClientMock");
 *     return createApiClientMock({
 *       useListContent: () => ({ data: mockState.content, isLoading: false }),
 *     });
 *   });
 */

export function idleMutation() {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
    // Query-shaped fields so the same stub also satisfies query hooks.
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  };
}

type MutationLike = { mutate: (vars: unknown, opts?: unknown) => void };
type RetryCallbacks = {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown, info: { retried: boolean }) => void;
};

const utilityDefaults: Record<string, unknown> = {
  isRestartRejection: () => false,
  RESTART_RETRY_DELAY_MS: 0,
  mutateWithRestartRetry: (m: MutationLike, vars: unknown, callbacks: RetryCallbacks) =>
    m.mutate(vars, {
      onSuccess: callbacks.onSuccess,
      onError: (err: unknown) => callbacks.onError?.(err, { retried: false }),
    }),
};

export function createApiClientMock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const cache = new Map<string, unknown>();

  const defaultFor = (name: string): unknown => {
    if (name in utilityDefaults) return utilityDefaults[name];
    if (/^use[A-Z]/.test(name)) return () => idleMutation();
    if (/^get[A-Z].*QueryKey$/.test(name)) return () => [name];
    return vi.fn();
  };

  return new Proxy(
    { ...overrides },
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
        if (prop in target) return Reflect.get(target, prop, receiver);
        // Module-namespace probes vitest/tooling may make; not real exports.
        if (prop === "default" || prop === "__esModule" || prop === "then") return undefined;
        if (!cache.has(prop)) cache.set(prop, defaultFor(prop));
        return cache.get(prop);
      },
      has(target, prop) {
        if (typeof prop !== "string") return Reflect.has(target, prop);
        if (prop === "default" || prop === "__esModule" || prop === "then") return false;
        return true;
      },
    },
  );
}
