import { describe, it, expect, vi, afterEach } from "vitest";
import {
  platformFetch,
  PlatformTimeoutError,
  PLATFORM_FETCH_TIMEOUT_MS,
} from "./platformFetch";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
});

describe("platformFetch", () => {
  it("stays comfortably below the 10s shutdown drain cap", () => {
    expect(PLATFORM_FETCH_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("returns the response on success and passes the init through", async () => {
    const res = new Response("ok", { status: 200 });
    const mock = vi.fn(async () => res);
    global.fetch = mock as unknown as typeof fetch;

    const out = await platformFetch("https://graph.facebook.com/x", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
    });
    expect(out).toBe(res);
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws PlatformTimeoutError with the host when the call hangs past the timeout", async () => {
    // Simulate a hung platform: fetch only rejects once the abort signal fires.
    global.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            new DOMException("The operation was aborted", "TimeoutError"),
          ),
        );
      })) as unknown as typeof fetch;

    await expect(
      platformFetch("https://api.x.com/2/tweets", undefined, 20),
    ).rejects.toMatchObject({
      name: "PlatformTimeoutError",
      message: expect.stringContaining("api.x.com"),
    });
  });

  it("rethrows non-timeout errors untouched", async () => {
    const boom = new Error("connection refused");
    global.fetch = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;

    await expect(
      platformFetch("https://graph.facebook.com/x"),
    ).rejects.toBe(boom);
  });

  it("respects a caller-supplied signal (caller abort is not a timeout)", async () => {
    const controller = new AbortController();
    global.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const pending = platformFetch(
      "https://graph.facebook.com/x",
      { signal: controller.signal },
      5_000,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending).rejects.not.toBeInstanceOf(PlatformTimeoutError);
  });
});
