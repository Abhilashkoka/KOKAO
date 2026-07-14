import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * HMAC-signed, tenant-bound, TTL'd OAuth `state` values, shared by every
 * platform's OAuth connect flow (X/Twitter, LinkedIn, ...).
 *
 * The wire format is base64url(`<tenantId>.<timestamp>.<data>.<sigHex>`) where
 * `data` is arbitrary opaque payload (e.g. a PKCE verifier or a random nonce)
 * that contains no constraint of its own — it may be empty. Tampering is caught
 * by the HMAC (keyed on SESSION_SECRET), replay is bounded by the TTL, and the
 * state is bound to the initiating tenant so it cannot be replayed cross-tenant.
 *
 * Fails closed: without SESSION_SECRET, signing throws and verification returns
 * null rather than accepting an unauthenticated state.
 */
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

function requireSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for OAuth state");
  return secret;
}

/** A random hex nonce for flows (like LinkedIn) that carry no PKCE verifier. */
export function randomNonce(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

/** Sign a state carrying the tenant id and an opaque `data` string. */
export function signOAuthState(tenantId: number, data = ""): string {
  const secret = requireSecret();
  const payload = `${tenantId}.${Date.now()}.${data}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

/**
 * Verify a state's signature and TTL and extract the tenant it was issued for.
 * Used by OAuth CALLBACKS, which arrive as top-level browser navigations that
 * may not carry an app session — the HMAC signature (keyed on SESSION_SECRET)
 * is what authenticates the request, and the embedded tenant id identifies the
 * workspace that initiated the flow. Returns null on any failure.
 * `data` may itself contain no dots (PKCE verifiers and hex nonces are
 * dot-free), so the payload is split into exactly three fields.
 */
export function verifySignedOAuthState(
  state: string,
  ttlMs = DEFAULT_STATE_TTL_MS,
): { tenantId: number; data: string } | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const firstDot = payload.indexOf(".");
    const secondDot = payload.indexOf(".", firstDot + 1);
    if (firstDot < 0 || secondDot < 0) return null;
    const tid = Number(payload.slice(0, firstDot));
    const ts = payload.slice(firstDot + 1, secondDot);
    const data = payload.slice(secondDot + 1);
    if (!Number.isInteger(tid) || tid <= 0) return null;
    if (!Number.isFinite(Number(ts)) || Date.now() - Number(ts) > ttlMs) {
      return null;
    }
    return { tenantId: tid, data };
  } catch {
    return null;
  }
}

/**
 * Verify a state against the expected tenant. Returns the opaque `data` (which
 * may be an empty string) when the signature, tenant binding, and TTL all pass;
 * otherwise returns null.
 */
export function verifyOAuthState(
  state: string,
  tenantId: number,
  ttlMs = DEFAULT_STATE_TTL_MS,
): { data: string } | null {
  const verified = verifySignedOAuthState(state, ttlMs);
  if (!verified || verified.tenantId !== tenantId) return null;
  return { data: verified.data };
}
