import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordServerEvent } = vi.hoisted(() => ({
  recordServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../analytics", () => ({ recordServerEvent }));

import {
  recordStudioLipSyncEvent,
  studioLipSyncSceneCountBucket,
  studioLipSyncWorkflow,
} from "./studioLipSyncAnalytics";

describe("Studio lip-sync analytics", () => {
  beforeEach(() => {
    recordServerEvent.mockClear();
  });

  it.each([
    [0, "0"],
    [1, "1"],
    [2, "2_3"],
    [3, "2_3"],
    [4, "4_6"],
    [6, "4_6"],
    [7, "7_plus"],
    [30, "7_plus"],
  ])("buckets %i scenes as %s", (count, bucket) => {
    expect(studioLipSyncSceneCountBucket(count)).toBe(bucket);
  });

  it("uses only coarse approved dimensions", () => {
    recordStudioLipSyncEvent({
      name: "studio_lipsync_finishing_succeeded",
      tenantId: 42,
      workflow: "guided_story",
      fundingRail: "wallet",
      sceneCount: 5,
      outcome: "succeeded",
    });

    expect(recordServerEvent).toHaveBeenCalledWith({
      name: "studio_lipsync_finishing_succeeded",
      tenantId: 42,
      params: {
        workflow: "guided_story",
        funding_rail: "wallet",
        scene_count_bucket: "4_6",
        outcome: "succeeded",
      },
    });
  });

  it("classifies supported Studio workflows without content fields", () => {
    expect(
      studioLipSyncWorkflow({
        engine: "topic_to_video",
        options: { guidedStory: { version: 1 } } as never,
      }),
    ).toBe("guided_story");
    expect(
      studioLipSyncWorkflow({
        engine: "topic_to_video",
        options: null,
      }),
    ).toBe("topic_character");
    expect(
      studioLipSyncWorkflow({
        engine: "text_to_video",
        options: null,
      }),
    ).toBe("text_to_video");
    expect(
      studioLipSyncWorkflow({
        engine: "image_to_video",
        options: null,
      }),
    ).toBe("animate_photo");
  });
});