declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

let checkoutScriptPromise: Promise<void> | null = null;

/** Load the Razorpay Checkout script once, on demand. */
export function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!checkoutScriptPromise) {
    checkoutScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve();
      script.onerror = () => {
        checkoutScriptPromise = null;
        reject(new Error("Could not load the payment window. Check your connection."));
      };
      document.body.appendChild(script);
    });
  }
  return checkoutScriptPromise;
}

/** Open Razorpay Checkout with the given options. */
export async function openCheckout(options: Record<string, unknown>): Promise<void> {
  await loadCheckoutScript();
  if (!window.Razorpay) throw new Error("Payment window unavailable");
  new window.Razorpay(options).open();
}

/** Paise → a rupee string, e.g. 118000 → "₹1,180". */
export function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
