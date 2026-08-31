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

// Replicate's Seedance 2.0 page publishes eight resolution/input variants.
const SEEDANCE_2_HTML = `
{"variants":[
 {"conditions":[{"field":"resolution","value":"480p"},{"field":"input_type","value":"non_video_in"}],"prices":[{"price":"$0.02","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"480p"},{"field":"input_type","value":"video_in"}],"prices":[{"price":"$0.04","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"720p"},{"field":"input_type","value":"non_video_in"}],"prices":[{"price":"$0.04","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"720p"},{"field":"input_type","value":"video_in"}],"prices":[{"price":"$0.08","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"1080p"},{"field":"input_type","value":"non_video_in"}],"prices":[{"price":"$0.08","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"1080p"},{"field":"input_type","value":"video_in"}],"prices":[{"price":"$0.16","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"1440p"},{"field":"input_type","value":"non_video_in"}],"prices":[{"price":"$0.12","title":"per second of output video"}]},
 {"conditions":[{"field":"resolution","value":"1440p"},{"field":"input_type","value":"video_in"}],"prices":[{"price":"$0.24","title":"per second of output video"}]}
]}
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
      { price: "$0.40", title: "per second of output video", criteria: { generateAudio: true } },
      { price: "$0.20", title: "per second of output video", criteria: { generateAudio: false } },
    ]);
  });

  it("preserves all eight Seedance 2.0 rates and normalized matching criteria", () => {
    const entries = extractPriceEntries(SEEDANCE_2_HTML);
    expect(entries).toHaveLength(8);
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          price: "$0.02",
          title: "per second of output video",
          criteria: { resolution: "480p", inputMode: "non_video" },
        },
        {
          price: "$0.24",
          title: "per second of output video",
          criteria: { resolution: "1440p", inputMode: "video" },
        },
      ]),
    );
  });

  it("retains unknown structured criteria with normalized keys", () => {
    const html = `{"criteria":{"Camera Type":"Front","batch_size":2},"prices":[{"price":"$0.05","title":"per video"}]}`;
    expect(extractPriceEntries(html)).toEqual([
      {
        price: "$0.05",
        title: "per video",
        criteria: { cameraType: "front", batchSize: "2" },
      },
    ]);
  });

  it("reads a server-rendered markdown pricing row when page JSON is absent", () => {
    expect(
      extractPriceEntries("| 720p | video_in | $0.08 per second of output video |"),
    ).toEqual([
      {
        price: "$0.08",
        title: "per second of output video",
        criteria: { resolution: "720p", inputMode: "video" },
      },
    ]);
  });

  it("collapses same-titled variants into a price range", () => {
    expect(formatPriceEntries(extractPriceEntries(VEO_HTML))).toBe(
      "$0.20–$0.40 per second of output video",
    );
  });

  it("formats a single entry verbatim and empty as null", () => {
    expect(formatPriceEntries([{ price: "$0.05", title: "per video", criteria: {} }])).toBe("$0.05 per video");
    expect(formatPriceEntries([])).toBeNull();
  });

  it("uses an explicitly published approximate per-run price for community video models", async () => {
    const html = `<p>Each run costs approximately $0.10, depending on the inputs.</p>`;
    expect(extractPriceEntries(html)).toEqual([
      { price: "$0.10", title: "per run (approximately)", criteria: {} },
    ]);
    vi.spyOn(platformFetchModule, "platformFetch").mockResolvedValue(htmlResponse(html));
    expect(await lookupReplicateUnitPricing(["bytedance/latentsync"])).toEqual([
      {
        model: "bytedance/latentsync",
        usdPerImage: null,
        usdPerSecond: null,
        usdPerVideo: 0.1,
        entries: [{ price: "$0.10", title: "per run (approximately)", criteria: {} }],
      },
    ]);
  });

  it.each([
    "Approximately $0.10 per run.",
    "This model costs about $0.10 to run.",
  ])("recognizes equivalent official approximate-run wording: %s", (html) => {
    expect(extractPriceEntries(html)).toEqual([
      { price: "$0.10", title: "per run (approximately)", criteria: {} },
    ]);
  });

  it("looks up per-slug pages with caching; invalid slugs skipped", async () => {
    const spy = vi
      .spyOn(platformFetchModule, "platformFetch")
      .mockResolvedValue(htmlResponse(VEO_HTML));
    const out = await lookupReplicatePricing(["google/veo-3", "not a slug!"]);
    expect(out).toEqual([
      {
        model: "google/veo-3",
        price: "$0.20–$0.40 per second of output video",
        entries: extractPriceEntries(VEO_HTML),
      },
      { model: "not a slug!", price: null, entries: [] },
    ]);
    await lookupReplicatePricing(["google/veo-3"]);
    expect(spy).toHaveBeenCalledTimes(1); // cached, invalid slug never fetched
  });

  it("fails soft on fetch errors", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockRejectedValue(new Error("down"));
    expect(await lookupReplicatePricing(["a/b"])).toEqual([{ model: "a/b", price: null, entries: [] }]);
  });
});
