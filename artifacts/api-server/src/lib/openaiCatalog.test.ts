import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractOpenAiPricing,
  lookupOpenAiPricing,
  resetOpenAiCatalogCache,
} from "./openaiCatalog";
import * as platformFetchModule from "./platformFetch";

const PRICING_MARKDOWN = `
## Standard token pricing
| Model | Short context input | Short context cached input | Short context output |
| --- | --- | --- | --- |
| gpt-5.4 | $2.50 | $0.25 | $15.00 |

## Standard image pricing
| Model | Modality | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| gpt-image-1 | Image | $10.00 | $2.50 | $40.00 |
| gpt-image-1 | Text | $5.00 | $1.25 | - |

## Batch image pricing
| Model | Modality | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| gpt-image-1 | Image | $5.00 | $1.25 | $20.00 |
| gpt-image-1 | Text | $2.50 | $0.625 | - |
`;

function markdownResponse(markdown: string) {
  return { ok: true, status: 200, text: async () => markdown } as unknown as Response;
}

describe("OpenAI pricing catalog", () => {
  beforeEach(() => resetOpenAiCatalogCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenAiCatalogCache();
  });

  it("extracts Standard prices and never replaces them with Batch rates", () => {
    expect(extractOpenAiPricing(PRICING_MARKDOWN)).toEqual(
      new Map([
        ["gpt-5.4", { model: "gpt-5.4", inputPerMTokens: 2.5, outputPerMTokens: 15 }],
        ["gpt-image-1", { model: "gpt-image-1", inputPerMTokens: 10, outputPerMTokens: 40 }],
      ]),
    );
  });

  it("uses only the fixed official catalog and caches it", async () => {
    const fetch = vi
      .spyOn(platformFetchModule, "platformFetch")
      .mockResolvedValue(markdownResponse(PRICING_MARKDOWN));

    await expect(lookupOpenAiPricing(["gpt-5.4", "unknown"])).resolves.toEqual([
      { model: "gpt-5.4", inputPerMTokens: 2.5, outputPerMTokens: 15 },
      { model: "unknown", inputPerMTokens: null, outputPerMTokens: null },
    ]);
    await lookupOpenAiPricing(["gpt-5.4"]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://developers.openai.com/api/docs/pricing.md",
      expect.any(Object),
    );
  });

  it("fails soft when the official catalog is unavailable", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockRejectedValue(new Error("offline"));
    await expect(lookupOpenAiPricing(["gpt-5.4"])).resolves.toEqual([
      { model: "gpt-5.4", inputPerMTokens: null, outputPerMTokens: null },
    ]);
  });
});