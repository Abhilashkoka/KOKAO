import { fetchRazorpayOrder, razorpayRequest } from "./razorpay";
import { getCashfreeOrder, getCashfreeRefund, getCashfreePayments, rupeesToPaise } from "./cashfree";
import { reconcileRefund } from "./refundReconciliation";
import { capturePaymentInstrument } from "./paymentInstruments";
import { logger } from "./logger";

interface RazorpayPayment {
  id: string; order_id: string; status: string; captured: boolean;
  amount: number; currency: string; vpa?: string; upi?: { vpa?: string };
}
function purchase(tags: Record<string, string>, amount: number) {
  const tenantId = Number(tags.tenantId);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid purchase binding");
  const kind = tags.purpose;
  if (!["credit_pack", "wallet_topup"].includes(kind ?? "")) return null;
  return { tenantId, kind: kind!, purchasePaise: amount };
}
export async function reconcileRazorpayRefund(refundId: string) {
  const refund = await razorpayRequest<{ id: string; payment_id: string; status: string; amount: number; currency: string }>(`/refunds/${encodeURIComponent(refundId)}`);
  if (refund.id !== refundId) throw new Error("Refund binding mismatch");
  // created is merely a hint: only canonical processed refunds change accounting.
  if (refund.status !== "processed") return;
  const payment = await razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(refund.payment_id)}`);
  if (payment.id !== refund.payment_id || !payment.order_id || !["captured", "refunded"].includes(payment.status) ||
      payment.currency !== "INR" || refund.currency !== "INR") throw new Error("Refund payment binding mismatch");
  const order = await fetchRazorpayOrder(payment.order_id);
  if (order.id !== payment.order_id || order.currency !== "INR" || order.status !== "paid" || payment.amount !== order.amount) throw new Error("Refund order binding mismatch");
  const binding = purchase(order.notes ?? {}, order.amount);
  if (!binding) return; // subscription cycles don't earn creator commission
  const result = await reconcileRefund({ ...binding, gateway: "razorpay", refundId, refId: order.id, refundedPaise: refund.amount });
  if (result.retryable) throw new Error("Refund receipt persistence unavailable");
}
export async function reconcileCashfreeRefund(orderId: string, refundId: string) {
  const refund = await getCashfreeRefund(orderId, refundId);
  if (refund.refund_id !== refundId || refund.order_id !== orderId) throw new Error("Refund binding mismatch");
  if (refund.refund_status !== "SUCCESS") return;
  const order = await getCashfreeOrder(orderId);
  if (order.order_id !== orderId || order.order_currency !== "INR" || order.order_status !== "PAID") throw new Error("Refund order binding mismatch");
  const payments = await getCashfreePayments(orderId);
  const payment = payments.find(p => p.order_id === orderId && p.payment_status === "SUCCESS" &&
    p.payment_currency === "INR" && rupeesToPaise(p.payment_amount) === rupeesToPaise(order.order_amount) &&
    (refund.cf_payment_id == null || String(p.cf_payment_id) === String(refund.cf_payment_id)));
  if (!payment) throw new Error("Refund payment binding mismatch");
  const binding = purchase(order.order_tags ?? {}, rupeesToPaise(order.order_amount));
  if (!binding) return;
  const result = await reconcileRefund({ ...binding, gateway: "cashfree", refundId, refId: orderId, refundedPaise: rupeesToPaise(refund.refund_amount) });
  if (result.retryable) throw new Error("Refund receipt persistence unavailable");
}
/** Called only after canonical purchase validation. Capture cannot fail payment fulfillment. */
export async function captureRazorpayInstrument(tenantId: number, orderId: string, paymentId: string | undefined, amount: number) {
  if (!paymentId) return;
  try {
    const p = await razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`);
    if (p.id !== paymentId || p.order_id !== orderId || p.status !== "captured" || p.currency !== "INR" || p.amount !== amount) return;
    await capturePaymentInstrument({ tenantId, gateway: "razorpay", vpa: p.vpa ?? p.upi?.vpa });
    // An opaque card ID/last4 is not a stable bank identifier. No bank verdict.
  } catch { logger.warn({ tenantId }, "Canonical payment instrument unavailable"); }
}
export async function captureCashfreeInstrument(tenantId: number, orderId: string, amount: number) {
  try {
    for (const p of await getCashfreePayments(orderId)) {
      if (p.order_id !== orderId || p.payment_status !== "SUCCESS" || p.payment_currency !== "INR" || rupeesToPaise(p.payment_amount) !== amount) continue;
      await capturePaymentInstrument({ tenantId, gateway: "cashfree", vpa: p.payment_method?.upi?.upi_id });
    }
  } catch { logger.warn({ tenantId }, "Canonical payment instrument unavailable"); }
}