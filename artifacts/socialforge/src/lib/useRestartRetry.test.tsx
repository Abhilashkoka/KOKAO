import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRestartRetry } from "@workspace/api-client-react";

/**
 * Guards the double-tap window during the automatic publish retry: while the
 * one-shot retry is waiting/running, no mutation is "pending", so UIs must
 * disable publish buttons on the hook's `isRetrying` flag instead.
 */

const restartError = {
  status: 503,
  data: {
    error:
      "The server is restarting. Your post was not published — please try again in a moment.",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useRestartRetry", () => {
  it("sets isRetrying while the retry waits, clears it on retry success", () => {
    let attempt = 0;
    const mutate = vi.fn((_vars: unknown, cbs: any) => {
      attempt += 1;
      if (attempt === 1) cbs.onError(restartError);
      else cbs.onSuccess({ ok: true });
    });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useRestartRetry());

    expect(result.current.isRetrying).toBe(false);
    act(() => {
      result.current.run({ mutate }, { id: 1 }, { onSuccess, onError: vi.fn() });
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.runAllTimers();
    });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(result.current.isRetrying).toBe(false);
  });

  it("clears isRetrying when the retry also fails", () => {
    const mutate = vi.fn((_vars: unknown, cbs: any) => cbs.onError(restartError));
    const onError = vi.fn();
    const { result } = renderHook(() => useRestartRetry());

    act(() => {
      result.current.run({ mutate }, { id: 2 }, { onSuccess: vi.fn(), onError });
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.runAllTimers();
    });
    expect(onError).toHaveBeenCalledWith(restartError, { retried: true });
    expect(result.current.isRetrying).toBe(false);
  });

  it("never sets isRetrying for immediate success or non-transient errors", () => {
    const okMutate = vi.fn((_vars: unknown, cbs: any) => cbs.onSuccess({ ok: true }));
    const failMutate = vi.fn((_vars: unknown, cbs: any) =>
      cbs.onError({ status: 500, data: { error: "boom" } }),
    );
    const { result } = renderHook(() => useRestartRetry());

    act(() => {
      result.current.run({ mutate: okMutate }, { id: 3 }, { onSuccess: vi.fn(), onError: vi.fn() });
      result.current.run({ mutate: failMutate }, { id: 4 }, { onSuccess: vi.fn(), onError: vi.fn() });
    });
    expect(result.current.isRetrying).toBe(false);
  });
});
