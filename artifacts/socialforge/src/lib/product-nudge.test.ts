import { describe, expect, it } from "vitest";
import { shouldNudgeProduct, topicMentionsProduct } from "./product-nudge";

describe("product nudge", () => {
  it("spots product-ad topics", () => {
    expect(topicMentionsProduct("A funny ad for our new night serum")).toBe(true);
    expect(topicMentionsProduct("Two friends argue over which saree to wear")).toBe(true);
    expect(topicMentionsProduct("Launch video for my skincare brand")).toBe(true);
  });

  it("stays quiet on generic topics", () => {
    expect(topicMentionsProduct("Why sleep matters for heart health")).toBe(false);
    expect(topicMentionsProduct("A doctor explains IVF myths with humour")).toBe(false);
    expect(topicMentionsProduct("Adventure in the mountains")).toBe(false);
  });

  it("only nudges when nothing is attached and not dismissed", () => {
    const base = { topic: "Comedy ad for our serum", selectedProducts: 0, productUploads: 0, dismissed: false };
    expect(shouldNudgeProduct(base)).toBe(true);
    expect(shouldNudgeProduct({ ...base, selectedProducts: 1 })).toBe(false);
    expect(shouldNudgeProduct({ ...base, productUploads: 1 })).toBe(false);
    expect(shouldNudgeProduct({ ...base, dismissed: true })).toBe(false);
    expect(shouldNudgeProduct({ ...base, topic: "ad" })).toBe(false);
  });
});
