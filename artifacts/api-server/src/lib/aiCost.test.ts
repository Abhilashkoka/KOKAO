import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, db, aiModelPricesTable, aiCostSettingsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  getAiCostConfig,
  setAiCostConfig,
  upsertModelPrice,
  deleteModelPrice,
  usdToPaise,
  computeTextCostPaise,
  computeImageCostPaise,
  usageAccountingParams,
  buildTextCostMeta,
  buildImageCostMeta,
} from "./aiCost";

// Unique names so runs against the shared dev DB never collide.
const RUN = `aicost-test-${Date.now()}`;
const TEXT_MODEL = `${RUN}-text-model`;
const IMAGE_MODEL = `${RUN}-image-model`;

let originalRatePaise: number;
const createdPriceIds: number[] = [];

beforeAll(async () => {
  originalRatePaise = (await getAiCostConfig()).usdToInrPaise;
});

afterAll(async () => {
  if (createdPriceIds.length > 0) {
    await db.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, createdPriceIds));
  }
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, usdToInrPaise: originalRatePaise })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: { usdToInrPaise: originalRatePaise, updatedAt: new Date() },
    });
  await pool.end();
});

describe("usdToPaise", () => {
  it("converts USD to whole paise using the rate", () => {
    expect(usdToPaise(1, 8600)).toBe(8600);
    expect(usdToPaise(0.5, 8600)).toBe(4300);
    expect(usdToPaise(0.001234, 8600)).toBe(11);
  });

  it("returns null when the rate is unset or the amount is invalid", () => {
    expect(usdToPaise(1, 0)).toBeNull();
    expect(usdToPaise(1, -5)).toBeNull();
    expect(usdToPaise(-1, 8600)).toBeNull();
    expect(usdToPaise(Number.NaN, 8600)).toBeNull();
  });
});

describe("usageAccountingParams", () => {
  it("only asks OpenRouter for usage cost accounting", () => {
    expect(usageAccountingParams("openrouter")).toEqual({ usage: { include: true } });
    expect(usageAccountingParams("builtin")).toEqual({});
  });
});

describe("cost computation with catalog + rate", () => {
  it("computes token-based text cost and flat image cost", async () => {
    await setAiCostConfig({ usdToInrPaise: 8600 }); // ₹86 per USD

    const textPrice = await upsertModelPrice({
      kind: "text",
      provider: "builtin",
      model: TEXT_MODEL,
      inputUsdPerMtok: 2, // $2 / 1M input tokens
      outputUsdPerMtok: 8, // $8 / 1M output tokens
      usdPerImage: null,
    });
    createdPriceIds.push(textPrice.id);

    const imagePrice = await upsertModelPrice({
      kind: "image",
      provider: "gemini",
      model: IMAGE_MODEL,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.04,
    });
    createdPriceIds.push(imagePrice.id);

    // 100k in + 50k out => $0.2 + $0.4 = $0.6 => 5160 paise
    expect(
      await computeTextCostPaise({
        provider: "builtin",
        model: TEXT_MODEL,
        inputTokens: 100_000,
        outputTokens: 50_000,
      }),
    ).toBe(5160);

    // $0.04 => 344 paise
    expect(await computeImageCostPaise({ provider: "gemini", model: IMAGE_MODEL })).toBe(344);
  });

  it("falls back to a model-only price match under another provider", async () => {
    expect(
      await computeTextCostPaise({
        provider: "openrouter",
        model: TEXT_MODEL,
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(17200); // $2 at ₹86
  });

  it("returns null for unknown models and never guesses", async () => {
    expect(
      await computeTextCostPaise({
        provider: "builtin",
        model: `${RUN}-unknown`,
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeNull();
    expect(
      await computeImageCostPaise({ provider: "builtin", model: `${RUN}-unknown` }),
    ).toBeNull();
  });

  it("returns null for everything when the rate is unset", async () => {
    await setAiCostConfig({ usdToInrPaise: 0 });
    expect(
      await computeTextCostPaise({
        provider: "builtin",
        model: TEXT_MODEL,
        inputTokens: 100_000,
        outputTokens: 50_000,
      }),
    ).toBeNull();
    expect(await computeImageCostPaise({ provider: "gemini", model: IMAGE_MODEL })).toBeNull();
    await setAiCostConfig({ usdToInrPaise: 8600 });
  });

  it("upsert updates the existing row instead of duplicating", async () => {
    const updated = await upsertModelPrice({
      kind: "text",
      provider: "builtin",
      model: TEXT_MODEL,
      inputUsdPerMtok: 4,
      outputUsdPerMtok: 16,
      usdPerImage: null,
    });
    expect(updated.id).toBe(createdPriceIds[0]);
    expect(
      await computeTextCostPaise({
        provider: "builtin",
        model: TEXT_MODEL,
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(34400); // $4 at ₹86
  });
});

describe("buildTextCostMeta", () => {
  it("uses the price catalog for non-OpenRouter providers", async () => {
    const meta = await buildTextCostMeta(
      { usage: { prompt_tokens: 100_000, completion_tokens: 0 } },
      { provider: "builtin", model: TEXT_MODEL },
    );
    expect(meta.provider).toBe("builtin");
    expect(meta.inputTokens).toBe(100_000);
    expect(meta.outputTokens).toBe(0);
    expect(meta.costPaise).toBe(3440); // $0.4 at ₹86
  });

  it("prefers OpenRouter's reported USD cost over the catalog", async () => {
    const meta = await buildTextCostMeta(
      { usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.01 } },
      { provider: "openrouter", model: TEXT_MODEL },
    );
    expect(meta.costPaise).toBe(86); // $0.01 at ₹86
    expect(meta.inputTokens).toBe(10);
    expect(meta.outputTokens).toBe(20);
  });

  it("records tokens but leaves cost unknown for unpriced models", async () => {
    const meta = await buildTextCostMeta(
      { usage: { prompt_tokens: 5, completion_tokens: 7 } },
      { provider: "builtin", model: `${RUN}-unknown` },
    );
    expect(meta.provider).toBe("builtin");
    expect(meta.inputTokens).toBe(5);
    expect(meta.outputTokens).toBe(7);
    expect(meta.costPaise).toBeUndefined();
  });

  it("handles a missing usage block gracefully", async () => {
    const meta = await buildTextCostMeta({}, { provider: "builtin", model: TEXT_MODEL });
    expect(meta.provider).toBe("builtin");
    expect(meta.inputTokens).toBeUndefined();
    expect(meta.costPaise).toBeUndefined();
  });
});

describe("token-based image costing", () => {
  const TOKEN_IMAGE_MODEL = `${RUN}-token-image-model`;

  it("uses token prices when the row has them and tokens are reported", async () => {
    const price = await upsertModelPrice({
      kind: "image",
      provider: "openai",
      model: TOKEN_IMAGE_MODEL,
      inputUsdPerMtok: 10, // $10 / 1M input tokens
      outputUsdPerMtok: 40, // $40 / 1M output tokens
      usdPerImage: 0.05, // flat fallback
    });
    createdPriceIds.push(price.id);

    // 10k in + 5k out => $0.1 + $0.2 = $0.3 => 2580 paise at ₹86
    expect(
      await computeImageCostPaise({
        provider: "openai",
        model: TOKEN_IMAGE_MODEL,
        inputTokens: 10_000,
        outputTokens: 5_000,
      }),
    ).toBe(2580);
  });

  it("falls back to the flat price when tokens are missing", async () => {
    // $0.05 => 430 paise
    expect(
      await computeImageCostPaise({ provider: "openai", model: TOKEN_IMAGE_MODEL }),
    ).toBe(430);
    expect(
      await computeImageCostPaise({
        provider: "openai",
        model: TOKEN_IMAGE_MODEL,
        inputTokens: 10_000,
        outputTokens: null,
      }),
    ).toBe(430);
  });

  it("returns null when only token prices exist and tokens are missing", async () => {
    const price = await upsertModelPrice({
      kind: "image",
      provider: "openai",
      model: `${TOKEN_IMAGE_MODEL}-tokens-only`,
      inputUsdPerMtok: 10,
      outputUsdPerMtok: 40,
      usdPerImage: null,
    });
    createdPriceIds.push(price.id);
    expect(
      await computeImageCostPaise({
        provider: "openai",
        model: `${TOKEN_IMAGE_MODEL}-tokens-only`,
      }),
    ).toBeNull();
  });

  it("buildImageCostMeta records tokens and the token-based cost", async () => {
    const meta = await buildImageCostMeta({
      provider: "openai",
      model: TOKEN_IMAGE_MODEL,
      usage: { inputTokens: 10_000, outputTokens: 5_000 },
    });
    expect(meta.provider).toBe("openai");
    expect(meta.inputTokens).toBe(10_000);
    expect(meta.outputTokens).toBe(5_000);
    expect(meta.costPaise).toBe(2580);
  });
});

describe("buildImageCostMeta", () => {
  it("computes the flat per-image cost", async () => {
    const meta = await buildImageCostMeta({ provider: "gemini", model: IMAGE_MODEL });
    expect(meta.provider).toBe("gemini");
    expect(meta.costPaise).toBe(344);
  });

  it("leaves cost unknown for unpriced image models", async () => {
    const meta = await buildImageCostMeta({ provider: "builtin", model: `${RUN}-unknown` });
    expect(meta.provider).toBe("builtin");
    expect(meta.costPaise).toBeUndefined();
  });
});

describe("deleteModelPrice", () => {
  it("removes a row and reports missing ids", async () => {
    const price = await upsertModelPrice({
      kind: "image",
      provider: "bfl",
      model: `${RUN}-delete-me`,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.05,
    });
    expect(await deleteModelPrice(price.id)).toBe(true);
    expect(await deleteModelPrice(price.id)).toBe(false);
  });
});
