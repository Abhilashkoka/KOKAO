import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isRestartRejection,
  isNetworkFailure,
  mutateWithRestartRetry,
  RESTART_RETRY_DELAY_MS,
} from "./restartRetry";

/**
 * Guards for the automatic publish retry on restart 503s:
 * - only the specific trackSyncPublish rejection triggers a retry (its 503
 *   is issued before any platform write, so nothing was posted);
 * - exactly ONE retry happens, after the delay;
 * - any other error, and a failed retry, reach the caller's error handler
 *   with the correct `retried` flag so a toast can inform the user.
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

describe("isRestartRejection", () => {
  it("matches the restart 503 contract", () => {
    expect(isRestartRejection(restartError)).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isRestartRejection({ status: 500, data: { error: "boom" } })).toBe(false);
    expect(isRestartRejection({ status: 503, data: { error: "over capacity" } })).toBe(false);
    expect(isRestartRejection({ status: 503 })).toBe(false);
    expect(isRestartRejection(new Error("network"))).toBe(false);
    expect(isRestartRejection(null)).toBe(false);
  });
});

describe("isNetworkFailure", () => {
  it("matches a fetch-style TypeError with no HTTP status", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new TypeError("Network request failed"))).toBe(true);
  });

  it("rejects errors that carry an HTTP status, aborts, and non-errors", () => {
    const apiError = Object.assign(new Error("HTTP 500"), { status: 500 });
    expect(isNetworkFailure(apiError)).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isNetworkFailure(abort)).toBe(false);
    expect(isNetworkFailure(new Error("plain"))).toBe(false);
    expect(isNetworkFailure({ status: 503 })).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe("mutateWithRestartRetry", () => {
  it("retries once after the delay when the restart 503 is returned, then succeeds", () => {
    let attempt = 0;
    const mutate = vi.fn((_vars: any, cbs: any) => {
      attempt += 1;
      if (attempt === 1) cbs.onError(restartError);
      else cbs.onSuccess({ ok: true });
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onRetrying = vi.fn();

    mutateWithRestartRetry({ mutate }, { id: 1 }, { onSuccess, onError, onRetrying });

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onRetrying).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]![0]).toEqual({ id: 1 });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports retried=true when the single retry also fails, and does NOT retry again", () => {
    const secondError = { status: 500, data: { error: "platform down" } };
    let attempt = 0;
    const mutate = vi.fn((_vars: any, cbs: any) => {
      attempt += 1;
      cbs.onError(attempt === 1 ? restartError : secondError);
    });
    const onError = vi.fn();

    mutateWithRestartRetry({ mutate }, { id: 2 }, { onSuccess: vi.fn(), onError });
    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(secondError, { retried: true });

    // Even if the retry fails with ANOTHER restart 503, no further retry.
    onError.mockClear();
    attempt = 0;
    const mutateAlwaysRestarting = vi.fn((_vars: any, cbs: any) => cbs.onError(restartError));
    mutateWithRestartRetry({ mutate: mutateAlwaysRestarting }, { id: 3 }, { onSuccess: vi.fn(), onError });
    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS * 2);
    expect(mutateAlwaysRestarting).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(restartError, { retried: true });
  });

  it("retries once on a network-class failure and reports reason 'network'", () => {
    let attempt = 0;
    const mutate = vi.fn((_vars: any, cbs: any) => {
      attempt += 1;
      if (attempt === 1) cbs.onError(new TypeError("Network request failed"));
      else cbs.onSuccess({ ok: true });
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onRetrying = vi.fn();

    mutateWithRestartRetry({ mutate }, { id: 6 }, { onSuccess, onError, onRetrying });

    expect(onRetrying).toHaveBeenCalledWith("network");
    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not retry a second time when the network keeps failing", () => {
    const mutate = vi.fn((_vars: any, cbs: any) =>
      cbs.onError(new TypeError("Failed to fetch")),
    );
    const onError = vi.fn();

    mutateWithRestartRetry({ mutate }, { id: 7 }, { onSuccess: vi.fn(), onError });
    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS * 2);

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toEqual({ retried: true });
  });

  it("passes non-restart errors straight through without retrying", () => {
    const err = { status: 403, data: { error: "not connected" } };
    const mutate = vi.fn((_vars: any, cbs: any) => cbs.onError(err));
    const onError = vi.fn();
    const onRetrying = vi.fn();

    mutateWithRestartRetry({ mutate }, { id: 4 }, { onSuccess: vi.fn(), onError, onRetrying });
    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS * 2);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onRetrying).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(err, { retried: false });
  });

  it("does not schedule anything on immediate success", () => {
    const mutate = vi.fn((_vars: any, cbs: any) => cbs.onSuccess({ permalink: "x" }));
    const onSuccess = vi.fn();

    mutateWithRestartRetry({ mutate }, { id: 5 }, { onSuccess, onError: vi.fn() });
    vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS * 2);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ permalink: "x" });
  });
});
