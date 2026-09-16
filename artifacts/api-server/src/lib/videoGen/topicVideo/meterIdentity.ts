import type { MeterContext } from "../../meter";

/**
 * Give a provider stage its own durable identity while retaining the owning
 * job's tenant, funding, and reference metadata. The stage is deliberately
 * independent of provider attempts: retries keep this family and only the
 * provider boundary appends its attempt suffix.
 */
export function childMeterContext(
  context: MeterContext | null | undefined,
  stage: string,
): MeterContext | null {
  if (!context) return null;
  const operationKey = context.operationKey?.trim() || null;
  const familyKey = context.operationFamilyKey?.trim() || operationKey;
  return {
    ...context,
    operationKey: operationKey ? `${operationKey}:${stage}` : stage,
    operationFamilyKey: familyKey ? `${familyKey}:${stage}` : stage,
  };
}