import { describe, expect, it } from "vitest";
import { verifyFailureNotice } from "./verifyFailureNotice";

const PENDING = "Payment still processing. Credits will be added automatically.";
const FALLBACK = "Payment received; credits will appear shortly.";

function apiError(status: number, body?: unknown) {
  return { status, data: body };
}

describe("verifyFailureNotice", () => {
  it("keeps a reassuring pending notice on 409", () => {
    const notice = verifyFailureNotice(
      apiError(409, { error: "Payment not yet captured" }),
      PENDING,
      FALLBACK,
    );
    expect(notice).toEqual({ kind: "info", text: PENDING });
  });

  it("shows 'Payment failed' with the exact server message on terminal 4xx", () => {
    const notice = verifyFailureNotice(
      apiError(400, { error: "Order not found or expired" }),
      PENDING,
      FALLBACK,
    );
    expect(notice.kind).toBe("error");
    expect(notice.text).toBe("Payment failed: Order not found or expired");
  });

  it("uses the support fallback on terminal 4xx without a server message", () => {
    const notice = verifyFailureNotice(apiError(422), PENDING, FALLBACK);
    expect(notice.kind).toBe("error");
    expect(notice.text).toBe(
      "Payment failed: The payment could not be verified. If you were charged, contact support.",
    );
  });

  it("keeps pending wording on 5xx even when the server sends an error body", () => {
    const notice = verifyFailureNotice(
      apiError(500, { error: "Internal server error" }),
      PENDING,
      FALLBACK,
    );
    expect(notice).toEqual({ kind: "info", text: FALLBACK });
  });

  it("keeps pending wording when the error has no status (network failure)", () => {
    const notice = verifyFailureNotice(new Error("network down"), PENDING, FALLBACK);
    expect(notice).toEqual({ kind: "info", text: FALLBACK });
  });
});
