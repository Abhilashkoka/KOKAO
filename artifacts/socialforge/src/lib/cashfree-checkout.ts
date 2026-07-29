// Cashfree JS v3 checkout wrapper. The modal resolves when it CLOSES, not
// when payment is confirmed — so "no error" only means "possibly paid". The
// server is the source of truth: callers must ALWAYS hit the verify endpoint
// afterwards (it re-checks status with Cashfree; a 409 means still pending).

interface CashfreeCheckoutOptions {
  paymentSessionId: string;
  redirectTarget?: string;
}

interface CashfreeSubscriptionCheckoutOptions {
  subsSessionId: string;
  redirectTarget?: string;
}

interface CashfreeCheckoutResult {
  paymentDetails?: unknown;
  error?: { message?: string } | null;
  redirect?: boolean;
}

interface CashfreeInstance {
  checkout: (options: CashfreeCheckoutOptions) => Promise<CashfreeCheckoutResult>;
  subscriptionsCheckout: (
    options: CashfreeSubscriptionCheckoutOptions,
  ) => Promise<CashfreeCheckoutResult>;
}

declare global {
  interface Window {
    Cashfree?: (options: { mode: "sandbox" | "production" }) => CashfreeInstance;
  }
}

let cashfreeScriptPromise: Promise<void> | null = null;

/** Load the Cashfree JS v3 SDK once, on demand. */
export function loadCashfree(): Promise<void> {
  if (window.Cashfree) return Promise.resolve();
  if (!cashfreeScriptPromise) {
    cashfreeScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
      script.onload = () => resolve();
      script.onerror = () => {
        cashfreeScriptPromise = null;
        reject(
          new Error("Could not load the payment window. Check your connection."),
        );
      };
      document.body.appendChild(script);
    });
  }
  return cashfreeScriptPromise;
}

/** The shape every Cashfree checkout resolves to once the modal closes. */
export interface CashfreeModalOutcome {
  /** True when the modal reported payment details (a payment was attempted). */
  completed: boolean;
  /** A user-facing error message, if the modal surfaced one. */
  error?: string;
}

function toOutcome(result: CashfreeCheckoutResult): CashfreeModalOutcome {
  if (result?.error) {
    return { completed: false, error: result.error.message };
  }
  // paymentDetails present (or a bare close with no error) → possibly paid;
  // the caller verifies with the server which is authoritative.
  return { completed: !!result?.paymentDetails };
}

/**
 * Open the Cashfree one-time-payment modal. Resolves when the modal closes.
 * The caller MUST verify the order with the server afterwards regardless of
 * the outcome — the modal closing is not proof of payment.
 */
export async function openCashfreeCheckout({
  paymentSessionId,
  mode,
}: {
  paymentSessionId: string;
  mode?: string | null;
}): Promise<CashfreeModalOutcome> {
  await loadCashfree();
  if (!window.Cashfree) throw new Error("Payment window unavailable");
  const cashfree = window.Cashfree({
    mode: mode === "production" ? "production" : "sandbox",
  });
  const result = await cashfree.checkout({
    paymentSessionId,
    redirectTarget: "_modal",
  });
  return toOutcome(result);
}

/**
 * Open the Cashfree subscription-authorization modal. Same contract as
 * {@link openCashfreeCheckout}: resolves on close, verify with the server.
 */
export async function openCashfreeSubscriptionCheckout({
  subscriptionSessionId,
  mode,
}: {
  subscriptionSessionId: string;
  mode?: string | null;
}): Promise<CashfreeModalOutcome> {
  await loadCashfree();
  if (!window.Cashfree) throw new Error("Payment window unavailable");
  const cashfree = window.Cashfree({
    mode: mode === "production" ? "production" : "sandbox",
  });
  const result = await cashfree.subscriptionsCheckout({
    subsSessionId: subscriptionSessionId,
    redirectTarget: "_modal",
  });
  return toOutcome(result);
}
