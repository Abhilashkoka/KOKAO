import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractGeminiPricing,
  lookupGeminiPricing,
  resetGeminiCatalogCache,
} from "./geminiCatalog";
import * as platformFetchModule from "./platformFetch";

const PRICING_MARKDOWN = `
## Gemini 2.5 Flash Image

_\`gemini-2.5-flash-image\`_

|  | Free Tier | Paid Tier, per 1M tokens in USD |
| --- | --- | --- |
| Input price | Free of charge | $0.30 (text / image / video) |
| Output price | Free of charge | $0.039 per image* |

## Gemini 3 Pro Image

_\`gemini-3-pro-image-preview\`_

|  | Free Tier | Paid Tier, per 1M tokens in USD |
| --- | --- | --- |
| Input price | Not available | $2.00 |
| Output price (including thinking tokens) | Not available | $120.00 |
`;

function markdownResponse(markdown: string) {
  return { ok: true, status: 200, text: async () => markdown } as unknown as Response;
}

describe("Gemini pricing catalog", () => {
  beforeEach(() => resetGeminiCatalogCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetGeminiCatalogCache();
  });

  it("maps each exact Gemini model id to its paid token prices", () => {
    expect(extractGeminiPricing(PRICING_MARKDOWN)).toEqual(
      new Map([
        [
          "gemini-2.5-flash-image",
          {
            model: "gemini-2.5-flash-image",
            inputPerMTokens: 0.3,
            outputPerMTokens: null,
            usdPerImage: 0.039,
          },
        ],
        [
          "gemini-3-pro-image-preview",
          {
            model: "gemini-3-pro-image-preview",
            inputPerMTokens: 2,
            outputPerMTokens: 120,
            usdPerImage: null,
          },
        ],
      ]),
    );
  });

  it("reads only the fixed canonical Google pricing document and caches it", async () => {
    const fetch = vi
      .spyOn(platformFetchModule, "platformFetch")
      .mockResolvedValue(markdownResponse(PRICING_MARKDOWN));

    await expect(lookupGeminiPricing(["gemini-2.5-flash-image", "unknown"])).resolves.toEqual([
      {
        model: "gemini-2.5-flash-image",
        inputPerMTokens: 0.3,
        outputPerMTokens: null,
        usdPerImage: 0.039,
      },
      { model: "unknown", inputPerMTokens: null, outputPerMTokens: null, usdPerImage: null },
    ]);
    await lookupGeminiPricing(["gemini-2.5-flash-image"]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://ai.google.dev/gemini-api/docs/pricing?hl=en",
      { headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" } },
    );
  });

  it("fails soft when Google's public catalog is unavailable", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockRejectedValue(new Error("offline"));
    await expect(lookupGeminiPricing(["gemini-2.5-flash-image"])).resolves.toEqual([
      {
        model: "gemini-2.5-flash-image",
        inputPerMTokens: null,
        outputPerMTokens: null,
        usdPerImage: null,
      },
    ]);
  });

  it("parses Google's raw HTML and preserves per-image output units", () => {
    const html = `
      <h2 id="gemini-2.5-flash-image">Gemini image</h2>
      <em><code>gemini-2.5-flash-image</code></em>
      <h3 id="standard_17">Standard</h3>
      <table><tbody>
        <tr><td>Input price</td><td>Not available</td><td>$0.30 (text / image)</td></tr>
        <tr><td>Output price</td><td>Not available</td><td>$0.039 per image*</td></tr>
      </tbody></table>
      <h2 id="next-model">Next</h2>
    `;
    expect(extractGeminiPricing(html).get("gemini-2.5-flash-image")).toEqual({
      model: "gemini-2.5-flash-image",
      inputPerMTokens: 0.3,
      outputPerMTokens: null,
      usdPerImage: 0.039,
    });
  });
});