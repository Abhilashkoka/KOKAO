/**
 * Payments started in this browser that have not been confirmed yet.
 *
 * A checkout can end without the verify call ever landing: the tab closes,
 * the phone loses signal, the gateway modal hangs. The webhook usually covers
 * that, but when it does not the customer has paid and sees nothing. Keeping
 * the gateway id here lets Restore purchases re-run the server's idempotent
 * verify with one tap. It is only a convenience: browser storage can be empty
 * or blocked, so every read and write is guarded and the server stays the
 * authority on whether anything was paid.
 */

export type PendingPaymentKind = "pack" | "subscription";

export interface PendingPayment {
  kind: PendingPaymentKind;
  /** Cashfree order id (pack) or subscription id (subscription). */
  id: string;
  label: string;
  startedAt: string;
}

const STORAGE_KEY = "kokao:pending-payments:v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10;

function read(): PendingPayment[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter(
      (p): p is PendingPayment =>
        !!p &&
        typeof p === "object" &&
        (p.kind === "pack" || p.kind === "subscription") &&
        typeof p.id === "string" &&
        p.id.length > 0 &&
        typeof p.label === "string" &&
        typeof p.startedAt === "string" &&
        Date.parse(p.startedAt) > cutoff,
    );
  } catch {
    return [];
  }
}

function write(entries: PendingPayment[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(-MAX_ENTRIES)),
    );
  } catch {
    // Storage blocked or full: the webhook and manual restore still work.
  }
}

export function listPendingPayments(): PendingPayment[] {
  return read();
}

export function rememberPendingPayment(
  kind: PendingPaymentKind,
  id: string,
  label: string,
): void {
  if (!id) return;
  const rest = read().filter((p) => !(p.kind === kind && p.id === id));
  write([...rest, { kind, id, label, startedAt: new Date().toISOString() }]);
}

export function forgetPendingPayment(kind: PendingPaymentKind, id: string): void {
  write(read().filter((p) => !(p.kind === kind && p.id === id)));
}
