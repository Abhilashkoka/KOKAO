import type { MeterFundingSnapshot } from "../meterFunding";

/** Missing snapshots identify historical jobs, never an invitation to migrate. */
export function videoFundingSnapshot(job: {
  tenantId: number;
  funding: "quota" | "credit" | "wallet" | "credits" | null;
  options?: { meterFunding?: MeterFundingSnapshot } | null;
}): MeterFundingSnapshot {
  const snapshot = job.options?.meterFunding;
  if (snapshot) {
    if (snapshot.tenantId !== job.tenantId || snapshot.rail !== (job.funding ?? "quota") ||
      (snapshot.rail === "credits" && snapshot.mode !== "enforce")) {
      throw new Error("Video funding snapshot does not match its durable job");
    }
    return Object.freeze({ ...snapshot });
  }
  if (job.funding === "credits") {
    throw new Error("Credit-funded video is missing its frozen funding snapshot");
  }
  return Object.freeze({
    tenantId: job.tenantId,
    rail: job.funding ?? "quota",
    mode: "shadow",
  });
}