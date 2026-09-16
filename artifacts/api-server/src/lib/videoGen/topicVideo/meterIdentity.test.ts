import { describe, expect, it } from "vitest";
import { childMeterContext } from "./meterIdentity";

describe("childMeterContext", () => {
  it("makes sibling stages distinct while preserving the frozen parent rail", () => {
    const parent = Object.freeze({
      tenantId: 7,
      refKind: "videoJob",
      refId: "42",
      funding: Object.freeze({
        tenantId: 7,
        rail: "wallet" as const,
        mode: "enforce" as const,
      }),
      operationKey: "video-job:42",
      operationFamilyKey: "video-job:42",
    });

    const script = childMeterContext(parent, "script");
    const broll = childMeterContext(parent, "broll-plan");
    const retry = childMeterContext(parent, "script");

    expect(script).toMatchObject({
      tenantId: 7,
      refKind: "videoJob",
      refId: "42",
      funding: parent.funding,
      operationKey: "video-job:42:script",
      operationFamilyKey: "video-job:42:script",
    });
    expect(broll?.operationFamilyKey).not.toBe(script?.operationFamilyKey);
    expect(retry).toEqual(script);
  });

  it("does not invent a durable meter context for legacy callers", () => {
    expect(childMeterContext(null, "script")).toBeNull();
    expect(childMeterContext(undefined, "script")).toBeNull();
  });
});