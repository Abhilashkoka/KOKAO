/**
 * Persists the plan + billing cycle a visitor picked on the public /pricing
 * page across the Clerk sign-up flow (which involves multi-step redirects
 * that drop query params), so the in-app billing flow can preselect it.
 *
 * Stored in localStorage with a short expiry: the intent should survive the
 * sign-up redirect dance but not resurface days later.
 */

const KEY = "kokao.signup-plan-intent";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export type BillingCycle = "monthly" | "yearly";

export interface PlanIntent {
  planId: string;
  cycle: BillingCycle;
  savedAt: number;
}

export function savePlanIntent(planId: string, cycle: BillingCycle): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ planId, cycle, savedAt: Date.now() } satisfies PlanIntent),
    );
  } catch {
    // Storage unavailable (private mode / blocked) — silently skip.
  }
}

export function readPlanIntent(): PlanIntent | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlanIntent>;
    if (
      typeof parsed.planId !== "string" ||
      (parsed.cycle !== "monthly" && parsed.cycle !== "yearly") ||
      typeof parsed.savedAt !== "number"
    ) {
      clearPlanIntent();
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      clearPlanIntent();
      return null;
    }
    return parsed as PlanIntent;
  } catch {
    return null;
  }
}

export function clearPlanIntent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
