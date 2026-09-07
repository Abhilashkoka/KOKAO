import { describe, expect, it } from "vitest";
import {
  BYTEPLUS_SEEDANCE_25_MODEL,
  parseBytePlusSeedancePricing,
} from "./byteplusPricing";

const SOURCE = `
  Seedance 2.5: From 14:00 (UTC+8) on August 14, 2026 through 14:00 (UTC+8)
  on September 17, 2026, 1080p output is billed at 28% off the list price.
  ### Dreamina Seedance 2.5
  * **Input without video**
  |**Resolution** |**Aspect ratio** |**Dreamina Seedance 2.5 price** |
  |---|---|---|
  |480p |16:9 |* 0.514 per video * 0.103 per second |
  |720p |16:9 |* 1.156 per video * 0.231 per second |
  |1080p |16:9 |* 2.843 per video * 0.569 per second |
  * **Input with video**
`;

describe("parseBytePlusSeedancePricing", () => {
  it("keeps all resolutions separate and attaches the exact promotion expiry", () => {
    const checkedAt = new Date("2026-09-07T12:00:00.000Z");
    const result = parseBytePlusSeedancePricing(SOURCE, checkedAt);

    expect(result.sourceCheckedAt).toEqual(checkedAt);
    expect(result.prices).toEqual([
      {
        resolution: "480p",
        usdPerSecond: 0.103,
        promotionalUsdPerSecond: null,
        promotionExpiresAt: null,
      },
      {
        resolution: "720p",
        usdPerSecond: 0.231,
        promotionalUsdPerSecond: null,
        promotionExpiresAt: null,
      },
      {
        resolution: "1080p",
        usdPerSecond: 0.569,
        promotionalUsdPerSecond: 0.40968,
        promotionExpiresAt: new Date("2026-09-17T06:00:00.000Z"),
      },
    ]);
  });

  it("fails closed when one resolution disappears from the provider page", () => {
    expect(() =>
      parseBytePlusSeedancePricing(SOURCE.replace("0.231 per second", "price unavailable")),
    ).toThrow("720p");
  });

  it("ignores duplicate resolution prose outside the exact no-video table", () => {
    const source = `480p costs 9.9 per second; 720p costs 8.8 per second; 1080p costs 7.7 per second.\n${SOURCE}`;
    expect(
      parseBytePlusSeedancePricing(source).prices.map((price) => price.usdPerSecond),
    ).toEqual([0.103, 0.231, 0.569]);
  });

  it("does not apply a promotion unless the notice explicitly scopes it to 1080p", () => {
    const source = SOURCE.replace("1080p output is billed", "all output is billed");
    expect(parseBytePlusSeedancePricing(source).prices[2].promotionalUsdPerSecond).toBeNull();
  });

  it("prefers the rendered Markdown inside BytePlus server data", () => {
    const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: {
        page: {
          curDoc: {
            Content: `${SOURCE} editor zones in non-visual order`,
            MDContent: SOURCE,
          },
        },
      },
    })}</script>`;

    expect(parseBytePlusSeedancePricing(html).prices.map((price) => price.resolution)).toEqual([
      "480p",
      "720p",
      "1080p",
    ]);
  });

  it("does not borrow rows from a later model section", () => {
    const laterTable = SOURCE.replace(
      "### Dreamina Seedance 2.5",
      "### Dreamina Seedance 2.0",
    );
    const source = `${SOURCE.replace(
      "* **Input without video**",
      "* pricing table temporarily unavailable",
    )}\n${laterTable}`;
    expect(() => parseBytePlusSeedancePricing(source)).toThrow("no-video table");
  });

  it("fails closed when structured BytePlus data has no readable Markdown", () => {
    const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: { page: { curDoc: { Content: SOURCE } } },
    })}</script>`;
    expect(() => parseBytePlusSeedancePricing(html)).toThrow("readable Markdown");
  });
});