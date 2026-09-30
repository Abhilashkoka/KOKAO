import { createHmac } from "node:crypto";
export class PayoutIdentityError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "PayoutIdentityError";
  }
}
export function hashPii(value: string): string {
  const secret = process.env.CREATOR_PII_PEPPER;
  if (!secret || secret.length < 32) throw new PayoutIdentityError("Payout details are not available until the server privacy key is configured.", "pii_not_configured");
  return createHmac("sha256", secret).update(value).digest("hex");
}