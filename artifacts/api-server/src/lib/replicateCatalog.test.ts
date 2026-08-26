import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lookupReplicatePricing,
  lookupReplicateUnitPricing,
  resetReplicateCatalogCache,
  extractPriceEntries,
  formatPriceEntries,
} from "./replicateCatalog";
import * as platformFetchModule from "./platformFetch";

const VEO_HTML = `
  {"variants": [{"conditions": [{"value": "with_audio"}], "prices": [{"description": "or 25 seconds for $10", "metric": "video_output_duration_seconds", "price": "$0.40", "title": "per second of output video", "type": "per-unit"}]},
  {"conditions": [{"value": "without_audio"}], "prices": [{"description": "or 50 seconds for $10", "metric": "video_output_duration_seconds", "price": "$0.20", "title": "per second of output video", "type": "per-unit"}]}]}
`;

function htmlResponse(html: string) {
  return { ok: true, status: 200, text: async () => html } as unknown as Response;
}

describe("replicateCatalog", () => {
  beforeEach(() => resetReplicateCatalogCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetReplicateCatalogCache();
  });

  it("extracts price entries from embedded page JSON", () => {
    expect(extractPriceEntries(VEO_HTML)).toEqual([
      { price: "$0.40", title: "per second of output video" },
      { price: "$0.20", title: "per second of output video" },
    ]);
  });

  it("collapses same-titled variants into a price range", () => {
    expect(formatPriceEntries(extractPriceEntries(VEO_HTML))).toBe(
      "$0.20–$0.40 per second of output video",
    );
  });

  it("formats a single entry verbatim and empty as null", () => {
    expect(formatPriceEntries([{ price: "$0.05", title: "per video" }])).toBe("$0.05 per video");
    expect(formatPriceEntries([])).toBeNull();
  });

  it("uses an explicitly published approximate per-run price for community video models", async () => {
    const html = `<p>Each run costs approximately $0.10, depending on the inputs.</p>`;
    expect(extractPriceEntries(html)).toEqual([
      { price: "$0.10", title: "per run (approximately)" },
    ]);
    vi.spyOn(platformFetchModule, "platformFetch").mockResolvedValue(htmlResponse(html));
    expect(await lookupReplicateUnitPricing(["bytedance/latentsync"])).toEqual([
      {
        model: "bytedance/latentsync",
        usdPerImage: null,
        usdPerSecond: null,
        usdPerVideo: 0.1,
      },
    ]);
  });

  it.each([
    "Approximately $0.10 per run.",
    "This model costs about $0.10 to run.",
  ])("recognizes equivalent official approximate-run wording: %s", (html) => {
    expect(extractPriceEntries(html)).toEqual([
      { price: "$0.10", title: "per run (approximately)" },
    ]);
  });

  it("looks up per-slug pages with caching; invalid slugs skipped", async () => {
    const spy = vi
      .spyOn(platformFetchModule, "platformFetch")
      .mockResolvedValue(htmlResponse(VEO_HTML));
    const out = await lookupReplicatePricing(["google/veo-3", "not a slug!"]);
    expect(out).toEqual([
      { model: "google/veo-3", price: "$0.20–$0.40 per second of output video" },
      { model: "not a slug!", price: null },
    ]);
    await lookupReplicatePricing(["google/veo-3"]);
    expect(spy).toHaveBeenCalledTimes(1); // cached, invalid slug never fetched
  });

  it("fails soft on fetch errors", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockRejectedValue(new Error("down"));
    expect(await lookupReplicatePricing(["a/b"])).toEqual([{ model: "a/b", price: null }]);
  });
});
