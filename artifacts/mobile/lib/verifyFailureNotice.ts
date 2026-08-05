import { apiErrorMessage } from "@/lib/apiErrorMessage";

export type VerifyNotice = {
  kind: "success" | "error" | "info";
  text: string;
};

/**
 * Maps a verify-payment failure to a user notice, mirroring the web billing
 * card's verifyFailureToast:
 * - 409  → reassuring "still processing" info notice
 * - other 4xx (terminal) → "Payment failed: <server message>" error notice
 * - 5xx / unknown (indeterminate) → pending fallback wording, never server text
 */
export function verifyFailureNotice(
  error: unknown,
  pendingText: string,
  fallbackText: string,
): VerifyNotice {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) {
    return { kind: "info", text: pendingText };
  }
  if (typeof status === "number" && status >= 400 && status < 500) {
    return {
      kind: "error",
      text: `Payment failed: ${apiErrorMessage(
        error,
        "The payment could not be verified. If you were charged, contact support.",
      )}`,
    };
  }
  return { kind: "info", text: fallbackText };
}
