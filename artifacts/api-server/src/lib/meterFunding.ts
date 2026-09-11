import { getMeterMode, type MeterMode } from "./creditRates";
import { isCreditFunded } from "./creditAccounts";

/**
 * The funding rail selected before a provider call starts.
 *
 * `credit` is the old per-action credit rail. `credits` is the credit-account
 * rail consumed by the meter itself. They are intentionally different: the
 * meter must never debit a credit account for a legacy reservation.
 */
export type MeterFundingRail = "quota" | "credit" | "wallet" | "credits";

/**
 * Immutable funding decision carried from the route reservation to every
 * provider-bound meter call.
 *
 * A provider pipeline can run across mode changes. It must therefore use the
 * mode selected by the route rather than consulting the mutable platform
 * setting again at the provider boundary.
 */
export type MeterFundingSnapshot = Readonly<{
  rail: MeterFundingRail;
  mode: MeterMode;
  tenantId: number;
}>;

/**
 * Freeze the meter mode and select the account-funded rail, if eligible.
 *
 * This is deliberately one resolver used by routes at their funding boundary.
 * `isCreditFunded` receives the already-read mode so it does not race a mode
 * transition by reading the global setting a second time.
 *
 * Other rails can replace `rail` on the returned immutable shape after their
 * own reservation succeeds; the mode remains the route's frozen decision.
 */
export async function freezeMeterFunding(tenantId: number): Promise<MeterFundingSnapshot> {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error("Cannot freeze meter funding without a valid tenant identity");
  }

  const mode = await getMeterMode();
  const rail: MeterFundingRail =
    mode === "enforce" && (await isCreditFunded(tenantId, mode))
      ? "credits"
      : "quota";

  return Object.freeze({ rail, mode, tenantId });
}

/** Read and freeze only the platform meter mode for a legacy funding rail. */
export async function freezeMeterMode(): Promise<MeterMode> {
  return getMeterMode();
}
