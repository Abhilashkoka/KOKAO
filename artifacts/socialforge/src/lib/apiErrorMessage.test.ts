import { describe, it, expect } from "vitest";
import { apiErrorMessage } from "./apiErrorMessage";

/** Minimal stand-in mirroring the shared client's ApiError shape. */
class FakeApiError extends Error {
  readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly data: unknown,
    readonly response: unknown = {},
  ) {
    super(`HTTP ${status}`);
  }
}

describe("apiErrorMessage", () => {
  it("reads the server message from error.data.error (ApiError shape)", () => {
    const err = new FakeApiError(400, {
      error: "Codes may only use letters, numbers, hyphens, and underscores.",
    });
    expect(apiErrorMessage(err, "fallback")).toBe(
      "Codes may only use letters, numbers, hyphens, and underscores.",
    );
  });

  it("does NOT rely on error.response.data (raw fetch Response)", () => {
    // error.response is a raw Response with no .data — the old broken
    // helpers read from there and always fell back.
    const err = new FakeApiError(409, { error: "That code already exists." }, new Response());
    expect(apiErrorMessage(err, "fallback")).toBe("That code already exists.");
  });

  it("falls back to message/detail fields", () => {
    expect(apiErrorMessage(new FakeApiError(400, { message: "Bad thing" }), "fb")).toBe(
      "Bad thing",
    );
    expect(apiErrorMessage(new FakeApiError(400, { detail: "Details here" }), "fb")).toBe(
      "Details here",
    );
  });

  it("uses a plain string body", () => {
    expect(apiErrorMessage(new FakeApiError(500, "  server blew up  "), "fb")).toBe(
      "server blew up",
    );
  });

  it("falls back when there is no usable message", () => {
    expect(apiErrorMessage(new FakeApiError(500, null), "fallback")).toBe("fallback");
    expect(apiErrorMessage(new FakeApiError(400, { error: "   " }), "fallback")).toBe(
      "fallback",
    );
    expect(apiErrorMessage(new FakeApiError(400, { error: 42 }), "fallback")).toBe(
      "fallback",
    );
    expect(apiErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(apiErrorMessage(new Error("plain"), "fallback")).toBe("fallback");
  });
});
