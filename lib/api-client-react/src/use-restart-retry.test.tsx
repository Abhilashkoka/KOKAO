// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useRestartRetry } from "./use-restart-retry";
import { RESTART_RETRY_DELAY_MS } from "./restart-retry";

/**
 * The hook tracks whether an automatic one-shot retry is waiting or in
 * flight so publish buttons stay disabled during that window. Verifies:
 * - isRetrying flips true when a retry is scheduled, false once it settles
 *   (both success and failure);
 * - overlapping publishes are counted independently (stays true until the
 *   LAST one settles);
 * - non-retried calls never touch the flag;
 * - the counter never goes negative, even with repeated settles.
 */

const restartError = {
  status: 503,
  data: {
    error:
      "The server is restarting. Your post was not published — please try again in a moment.",
  },
};

function makeRetryingMutation(finalOutcome: "success" | "error") {
  let attempt = 0;
  const mutate = vi.fn((_vars: unknown, cbs?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
    attempt += 1;
    if (attempt === 1) cbs?.onError?.(restartError);
    else if (finalOutcome === "success") cbs?.onSuccess?.({ ok: true });
    else cbs?.onError?.({ status: 500, data: { error: "platform down" } });
  });
  return { mutate };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useRestartRetry", () => {
  it("is false initially and stays false for an immediate success", () => {
    const { result } = renderHook(() => useRestartRetry());
    expect(result.current.isRetrying).toBe(false);

    const mutation = {
      mutate: vi.fn((_v: unknown, cbs?: { onSuccess?: (r: unknown) => void }) =>
        cbs?.onSuccess?.({ ok: true }),
      ),
    };
    const onSuccess = vi.fn();
    act(() => {
      result.current.run(mutation, { id: 1 }, { onSuccess, onError: vi.fn() });
    });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(result.current.isRetrying).toBe(false);
  });

  it("stays false for an immediate non-retryable error", () => {
    const { result } = renderHook(() => useRestartRetry());
    const err = { status: 403, data: { error: "not connected" } };
    const mutation = {
      mutate: vi.fn((_v: unknown, cbs?: { onError?: (e: unknown) => void }) =>
        cbs?.onError?.(err),
      ),
    };
    const onError = vi.fn();
    act(() => {
      result.current.run(mutation, { id: 1 }, { onSuccess: vi.fn(), onError });
    });
    expect(onError).toHaveBeenCalledWith(err, { retried: false });
    expect(result.current.isRetrying).toBe(false);
  });

  it("turns true while the retry waits and false after it succeeds", () => {
    const { result } = renderHook(() => useRestartRetry());
    const mutation = makeRetryingMutation("success");
    const onSuccess = vi.fn();
    const onRetrying = vi.fn();

    act(() => {
      result.current.run(mutation, { id: 1 }, { onSuccess, onError: vi.fn(), onRetrying });
    });
    expect(onRetrying).toHaveBeenCalledWith("restart");
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(result.current.isRetrying).toBe(false);
  });

  it("turns false after the retry fails, reporting retried=true", () => {
    const { result } = renderHook(() => useRestartRetry());
    const mutation = makeRetryingMutation("error");
    const onError = vi.fn();

    act(() => {
      result.current.run(mutation, { id: 2 }, { onSuccess: vi.fn(), onError });
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(onError).toHaveBeenCalledWith(
      { status: 500, data: { error: "platform down" } },
      { retried: true },
    );
    expect(result.current.isRetrying).toBe(false);
  });

  it("stays true until the LAST of two overlapping retries settles", () => {
    const { result } = renderHook(() => useRestartRetry());

    // First retry settles after the standard delay; the second uses a
    // longer delay so it is still pending when the first finishes.
    const first = makeRetryingMutation("success");
    const second = makeRetryingMutation("error");

    act(() => {
      result.current.run(first, { id: 1 }, { onSuccess: vi.fn(), onError: vi.fn() });
      result.current.run(
        second,
        { id: 2 },
        { onSuccess: vi.fn(), onError: vi.fn() },
        RESTART_RETRY_DELAY_MS * 3,
      );
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    // First settled; second still waiting.
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS * 2);
    });
    expect(result.current.isRetrying).toBe(false);
  });

  it("never goes negative: a settle is counted at most once per retry", () => {
    const { result } = renderHook(() => useRestartRetry());

    // Pathological mutation: on the retry attempt it fires onError TWICE.
    let attempt = 0;
    const mutation = {
      mutate: vi.fn((_v: unknown, cbs?: { onError?: (e: unknown) => void }) => {
        attempt += 1;
        if (attempt === 1) {
          cbs?.onError?.(restartError);
        } else {
          cbs?.onError?.({ status: 500, data: { error: "boom" } });
          cbs?.onError?.({ status: 500, data: { error: "boom again" } });
        }
      }),
    };

    act(() => {
      result.current.run(mutation, { id: 1 }, { onSuccess: vi.fn(), onError: vi.fn() });
    });
    expect(result.current.isRetrying).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(result.current.isRetrying).toBe(false);

    // A fresh retry after the double-settle must still flip the flag true —
    // proof the internal counter did not dip below zero.
    const next = makeRetryingMutation("success");
    act(() => {
      result.current.run(next, { id: 2 }, { onSuccess: vi.fn(), onError: vi.fn() });
    });
    expect(result.current.isRetrying).toBe(true);
    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(result.current.isRetrying).toBe(false);
  });

  it("`run` is referentially stable across rerenders", () => {
    const { result, rerender } = renderHook(() => useRestartRetry());
    const firstRun = result.current.run;
    rerender();
    expect(result.current.run).toBe(firstRun);
  });
});
