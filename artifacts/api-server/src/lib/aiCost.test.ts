import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, db, aiModelPricesTable, aiCostSettingsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  getAiCostConfig,
  setAiCostConfig,
  setElevenLabsCreditRate,
  upsertModelPrice,
  deleteModelPrice,
  usdToPaise,
  computeTextCostPaise,
  computeImageCostPaise,
  computeVideoCostPaise,
  computeElevenLabsCreditCostPaise,
  elevenLabsCreditReservationCeiling,
  elevenLabsCreditsToPaise,
  usageAccountingParams,
  streamUsageParams,
  imageUnitCostsPaise,
  buildTextCostMeta,
  buildImageCostMeta,
  dedupeModelPrices,
  canonicalVideoVariantKey,
  seedPublishedModelPrices,
  hasVideoModelPriceConfiguration,
} from "./aiCost";

// Unique names so runs against the shared dev DB never collide.
const RUN = `aicost-test-${Date.now()}`;
const TEXT_MODEL = `${RUN}-text-model`;
const IMAGE_MODEL = `${RUN}-image-model`;
let originalRatePaise: number;
let originalElevenLabsRate: string | null;
const createdPriceIds: number[] = [];
let textPriceId: number;

beforeAll(async () => {
  const config = await getAiCostConfig();
  originalRatePaise = config.usdToInrPaise;
  originalElevenLabsRate = config.elevenLabsInrPerCredit;
});

afterAll(async () => {
  if (createdPriceIds.length > 0) {
    await db.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, createdPriceIds));
  }
  await db
    .insert(aiCostSettingsTable)
    .values({
      id: 1,
      usdToInrPaise: originalRatePaise,
      elevenLabsInrPerCredit: originalElevenLabsRate,
    })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: {
        usdToInrPaise: originalRatePaise,
        elevenLabsInrPerCredit: originalElevenLabsRate,
        updatedAt: new Date(),
      },
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

describe("published server-owned model prices", () => {
  it("seeds the LatentSync per-run price required before optional lip-sync", async () => {
    await seedPublishedModelPrices();
    const [price] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "video"),
          eq(aiModelPricesTable.provider, "replicate"),
          eq(aiModelPricesTable.model, "bytedance/latentsync"),
        ),
      )
      .limit(1);

    expect(price?.usdPerVideo).toBeGreaterThan(0);
  });
});

describe("usageAccountingParams", () => {
  it("only asks OpenRouter for usage cost accounting", () => {
    expect(usageAccountingParams("openrouter")).toEqual({ usage: { include: true } });
    expect(usageAccountingParams("builtin")).toEqual({});
  });
});

describe("streamUsageParams", () => {
  it("asks for a final usage chunk on every streaming backend", () => {
    // Both text backends are OpenAI-compatible and honour this, which is why
    // it is not conditional on the provider the way usage accounting is.
    expect(streamUsageParams()).toEqual({ stream_options: { include_usage: true } });
  });
});

describe("cost computation with catalog + rate", () => {
  it("converts exact ElevenLabs credits with integer arithmetic and rounds positive sub-paise cost up", async () => {
    expect(elevenLabsCreditsToPaise("10", "0.005")).toBe(5);
    expect(elevenLabsCreditsToPaise("0.5", "0.01")).toBe(1);
    expect(elevenLabsCreditsToPaise("0", "0.01")).toBe(0);
    expect(elevenLabsCreditsToPaise("1", "0.00000001")).toBe(1);
    expect(elevenLabsCreditsToPaise("1.000000001", "1")).toBeNull();
    expect(elevenLabsCreditsToPaise("not-a-credit", "1")).toBeNull();
    expect(Number(elevenLabsCreditReservationCeiling("₹"))).toBeGreaterThan("₹".length);

    await setElevenLabsCreditRate("0.00500000");
    expect(await computeElevenLabsCreditCostPaise("10")).toBe(5);
    await setElevenLabsCreditRate(null);
    expect(await computeElevenLabsCreditCostPaise("10")).toBeNull();
  });
  it("computes token-based text cost and flat image cost", async () => {
    await setAiCostConfig({ usdToInrPaise: 8600 }); // ₹86 per USD

    const textPrice = await upsertModelPrice({
      kind: "text",
      provider: "builtin",
      model: TEXT_MODEL,
      inputUsdPerMtok: 2, // $2 / 1M input tokens
      outputUsdPerMtok: 8, // $8 / 1M output tokens
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null
    });
    createdPriceIds.push(textPrice.id);
    textPriceId = textPrice.id;

    const imagePrice = await upsertModelPrice({
      kind: "image",
      provider: "gemini",
      model: IMAGE_MODEL,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.04,
      usdPerSecond: null,
      usdPerVideo: null
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

  it("computes video cost per second when a $/second rate and duration exist", async () => {
    const videoPrice = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}-video-model`,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.4,
      usdPerVideo: 2,
    });
    createdPriceIds.push(videoPrice.id);

    // 8s × $0.4 = $3.2 at ₹86 => 27520 paise
    expect(
      await computeVideoCostPaise({
        provider: "replicate",
        model: `${RUN}-video-model`,
        durationSec: 8,
      }),
    ).toBe(27520);
    // No measured duration → falls back to the flat per-video price ($2)
    expect(
      await computeVideoCostPaise({ provider: "replicate", model: `${RUN}-video-model` }),
    ).toBe(17200);
    // Unknown model → null, never guessed
    expect(
      await computeVideoCostPaise({
        provider: "replicate",
        model: `${RUN}-unknown-video`,
        durationSec: 8,
      }),
    ).toBeNull();
  });

  it("video cost is null when only $/second is priced and duration is unknown", async () => {
    const perSecondOnly = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}-persecond-only`,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.5,
      usdPerVideo: null,
    });
    createdPriceIds.push(perSecondOnly.id);
    expect(
      await computeVideoCostPaise({ provider: "replicate", model: `${RUN}-persecond-only` }),
    ).toBeNull();
    expect(
      await computeVideoCostPaise({
        provider: "replicate",
        model: `${RUN}-persecond-only`,
        durationSec: 10,
      }),
    ).toBe(43000); // 10s × $0.5 = $5 at ₹86
  });

  it("upsert updates the existing row instead of duplicating", async () => {
    const updated = await upsertModelPrice({
      kind: "text",
      provider: "builtin",
      model: TEXT_MODEL,
      inputUsdPerMtok: 4,
      outputUsdPerMtok: 16,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null
    });
    expect(updated.id).toBe(textPriceId);
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

describe("variant-aware video pricing", () => {
  const MODEL = `${RUN}-variant-video`;

  it("uses a deterministic key while keeping distinct variants separate", () => {
    expect(canonicalVideoVariantKey({ quality: "high", duration: 10 })).toBe(
      canonicalVideoVariantKey({ duration: 10, quality: "high" }),
    );
    expect(canonicalVideoVariantKey({ quality: "high" })).not.toBe(
      canonicalVideoVariantKey({ quality: "standard" }),
    );
  });

  it("matches exact variants, rejects unmatched conditional variants, and chooses the most specific match", async () => {
    await setAiCostConfig({ usdToInrPaise: 8600 });
    const defaultPrice = await upsertModelPrice({
      kind: "video", provider: "replicate", model: MODEL,
      inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: null,
      usdPerSecond: null, usdPerVideo: 1,
    });
    const qualityPrice = await upsertModelPrice({
      kind: "video", provider: "replicate", model: MODEL,
      variantCriteria: { quality: "high" },
      inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: null,
      usdPerSecond: null, usdPerVideo: 2,
    });
    const specificPrice = await upsertModelPrice({
      kind: "video", provider: "replicate", model: MODEL,
      variantCriteria: { duration: 10, quality: "high" },
      inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: null,
      usdPerSecond: null, usdPerVideo: 3,
    });
    createdPriceIds.push(defaultPrice.id, qualityPrice.id, specificPrice.id);

    expect(await computeVideoCostPaise({
      provider: "replicate", model: MODEL, variantCriteria: { quality: "high" },
    })).toBe(17200);
    expect(await computeVideoCostPaise({
      provider: "replicate", model: MODEL, variantCriteria: { quality: "high", duration: 10 },
    })).toBe(25800);
    // Conditional rows exist, so an unmatched request must not use $1 default.
    expect(await computeVideoCostPaise({
      provider: "replicate", model: MODEL, variantCriteria: { quality: "standard" },
    })).toBeNull();
    expect(await hasVideoModelPriceConfiguration({
      provider: "replicate", model: MODEL,
    })).toBe(true);
    expect(await hasVideoModelPriceConfiguration({
      provider: "openrouter", model: MODEL,
    })).toBe(false);
  });

  it("retains the legacy default-row fallback when no conditional rows exist", async () => {
    const price = await upsertModelPrice({
      kind: "video", provider: "replicate", model: `${MODEL}-legacy`,
      inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: null,
      usdPerSecond: null, usdPerVideo: 1.5,
    });
    createdPriceIds.push(price.id);
    expect(await computeVideoCostPaise({
      provider: "replicate", model: `${MODEL}-legacy`, variantCriteria: { quality: "high" },
    })).toBe(12900);
  });

  it("lets a newly saved generic video price supersede stale conditional rows", async () => {
    const model = `${MODEL}-generic-supersedes`;
    const conditional = await upsertModelPrice({
      kind: "video", provider: "openrouter", model,
      variantCriteria: { quality: "low", resolution: "480p" },
      inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: null,
      usdPerSecond: 0.12, usdPerVideo: null,
    });
    const generic = await upsertModelPrice({
      kind: "video", provider: "openrouter", model,
      inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: null,
      usdPerSecond: 0.23, usdPerVideo: null,
    });
    createdPriceIds.push(conditional.id, generic.id);

    expect(await computeVideoCostPaise({
      provider: "openrouter",
      model,
      durationSec: 5,
      variantCriteria: {
        inputMode: "non_video",
        quality: "high",
        resolution: "720p",
      },
    })).toBe(9890);
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

  it("attributes NVIDIA multimodal chat tokens to its serving model", async () => {
    const meta = await buildTextCostMeta(
      { usage: { prompt_tokens: 12, completion_tokens: 7 } },
      { provider: "nvidia", model: TEXT_MODEL },
    );
    expect(meta).toMatchObject({
      provider: "nvidia",
      inputTokens: 12,
      outputTokens: 7,
    });
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

  it("records the cached and reasoning subsets when the provider reports them", async () => {
    const meta = await buildTextCostMeta(
      {
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 400 },
          completion_tokens_details: { reasoning_tokens: 250 },
        },
      },
      { provider: "builtin", model: TEXT_MODEL },
    );
    expect(meta.cachedInputTokens).toBe(400);
    expect(meta.reasoningTokens).toBe(250);
    // The split is recorded, not discounted: cost is still the full 1M input
    // tokens at $4/Mtok. Discounting would need its own price column.
    expect(meta.costPaise).toBe(34400);
  });

  it("leaves the subsets unset rather than zero when the provider is silent", async () => {
    const meta = await buildTextCostMeta(
      { usage: { prompt_tokens: 10, completion_tokens: 20 } },
      { provider: "builtin", model: TEXT_MODEL },
    );
    // undefined means "not reported"; 0 would claim the provider cached nothing.
    expect(meta.cachedInputTokens).toBeUndefined();
    expect(meta.reasoningTokens).toBeUndefined();
  });

  it("ignores a null details block", async () => {
    const meta = await buildTextCostMeta(
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          prompt_tokens_details: null,
          completion_tokens_details: null,
        },
      },
      { provider: "builtin", model: TEXT_MODEL },
    );
    expect(meta.cachedInputTokens).toBeUndefined();
    expect(meta.reasoningTokens).toBeUndefined();
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
      usdPerImage: 0.05, // flat fallback,
      usdPerSecond: null,
      usdPerVideo: null
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
      usdPerSecond: null,
      usdPerVideo: null,
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

describe("imageUnitCostsPaise", () => {
  const CHEAP = `${RUN}-cheap-image`;
  const DEAR = `${RUN}-dear-image`;
  const TOKENS_ONLY = `${RUN}-tokens-only-image`;

  beforeAll(async () => {
    await setAiCostConfig({ usdToInrPaise: 8600 });
    for (const [model, usd] of [
      [CHEAP, 0.02],
      [DEAR, 0.04],
    ] as const) {
      const row = await upsertModelPrice({
        kind: "image",
        provider: "bfl",
        model,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
        usdPerImage: usd,
        usdPerSecond: null,
        usdPerVideo: null
      });
      createdPriceIds.push(row.id);
    }
    const tokensOnly = await upsertModelPrice({
      kind: "image",
      provider: "bfl",
      model: TOKENS_ONLY,
      inputUsdPerMtok: 10,
      outputUsdPerMtok: 40,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null
    });
    createdPriceIds.push(tokensOnly.id);
  });

  it("prices each candidate by its id", async () => {
    const costs = await imageUnitCostsPaise([
      { id: "a", provider: "bfl", model: CHEAP },
      { id: "b", provider: "bfl", model: DEAR },
    ]);
    expect(costs.get("a")).toBe(172); // $0.02 at ₹86
    expect(costs.get("b")).toBe(344); // $0.04 at ₹86
  });

  it("matches a model priced under another provider", async () => {
    // One price row can cover a model reachable directly and via a gateway.
    const costs = await imageUnitCostsPaise([
      { id: "via-gateway", provider: "openrouter", model: CHEAP },
    ]);
    expect(costs.get("via-gateway")).toBe(172);
  });

  it("omits candidates with no usable per-image price", async () => {
    const costs = await imageUnitCostsPaise([
      { id: "unknown", provider: "bfl", model: `${RUN}-never-priced` },
      { id: "token-priced", provider: "bfl", model: TOKENS_ONLY },
      { id: "known", provider: "bfl", model: CHEAP },
    ]);
    // An unpriced candidate is absent, not zero — free would win every time.
    expect(costs.has("unknown")).toBe(false);
    expect(costs.has("token-priced")).toBe(false);
    expect(costs.get("known")).toBe(172);
  });

  it("does not query at all for an empty candidate list", async () => {
    expect(await imageUnitCostsPaise([])).toEqual(new Map());
  });

  it("prices nothing while the USD rate is unset", async () => {
    await setAiCostConfig({ usdToInrPaise: 0 });
    expect(await imageUnitCostsPaise([{ id: "a", provider: "bfl", model: CHEAP }])).toEqual(
      new Map(),
    );
    await setAiCostConfig({ usdToInrPaise: 8600 });
  });
});

describe("upsertModelPrice case-insensitive dedupe", () => {
  it("updates an existing row that differs only in case/whitespace instead of adding one", async () => {
    const first = await upsertModelPrice({
      kind: "text",
      provider: "OpenRouter",
      model: `${RUN}-CasedModel`,
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    createdPriceIds.push(first.id);

    const second = await upsertModelPrice({
      kind: "text",
      provider: " openrouter ",
      model: ` ${RUN}-casedmodel `,
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 4,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });

    // Same row updated in place, keeping the originally stored key strings.
    expect(second.id).toBe(first.id);
    expect(second.provider).toBe("OpenRouter");
    expect(second.model).toBe(`${RUN}-CasedModel`);
    expect(second.inputUsdPerMtok).toBe(3);
    expect(second.outputUsdPerMtok).toBe(4);
  });

  it("folds pre-existing case duplicates into the oldest row on save", async () => {
    // Simulate historical duplicates written before normalization existed.
    const [a] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "image",
        provider: "bfl",
        model: `${RUN}-Dup-Model`,
        usdPerImage: 0.01,
      })
      .returning();
    const [b] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "image",
        provider: "BFL",
        model: `${RUN}-dup-model`,
        usdPerImage: 0.09,
      })
      .returning();
    createdPriceIds.push(a.id, b.id);

    const saved = await upsertModelPrice({
      kind: "image",
      provider: "bfl",
      model: `${RUN}-DUP-MODEL`,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.05,
      usdPerSecond: null,
      usdPerVideo: null,
    });

    expect(saved.id).toBe(a.id);
    expect(saved.usdPerImage).toBe(0.05);
    const remaining = await db
      .select()
      .from(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, [a.id, b.id]));
    expect(remaining.map((r) => r.id)).toEqual([a.id]);
  });
});

describe("dedupeModelPrices", () => {
  it("merges case/whitespace duplicates keeping the oldest row and the newest prices", async () => {
    const old = new Date(Date.now() - 60_000);
    const [a] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "text",
        provider: "OpenRouter",
        model: `${RUN}-Sweep-Model`,
        inputUsdPerMtok: 1,
        outputUsdPerMtok: 2,
        updatedAt: old,
      })
      .returning();
    const [b] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "text",
        provider: " openrouter ",
        model: ` ${RUN}-sweep-model `,
        inputUsdPerMtok: 5,
        outputUsdPerMtok: 6,
      })
      .returning();
    createdPriceIds.push(a.id, b.id);

    const merges = await dedupeModelPrices();
    const merge = merges.find((m) => m.keptId === a.id);
    expect(merge).toBeDefined();
    expect(merge!.removed.map((r) => r.id)).toEqual([b.id]);
    expect(merge!.pricesTakenFromId).toBe(b.id);

    const remaining = await db
      .select()
      .from(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, [a.id, b.id]));
    expect(remaining).toHaveLength(1);
    // Oldest row survives with its stored key strings, newest prices win.
    expect(remaining[0].id).toBe(a.id);
    expect(remaining[0].provider).toBe("OpenRouter");
    expect(remaining[0].model).toBe(`${RUN}-Sweep-Model`);
    expect(remaining[0].inputUsdPerMtok).toBe(5);
    expect(remaining[0].outputUsdPerMtok).toBe(6);
  });

  it("keeps the kept row's prices when it is itself the most recently updated", async () => {
    const old = new Date(Date.now() - 60_000);
    const [a] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "image",
        provider: "bfl",
        model: `${RUN}-Sweep-Img`,
        usdPerImage: 0.04,
      })
      .returning();
    const [b] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "image",
        provider: "BFL",
        model: `${RUN}-sweep-img`,
        usdPerImage: 0.99,
        updatedAt: old,
      })
      .returning();
    createdPriceIds.push(a.id, b.id);

    await dedupeModelPrices();

    const remaining = await db
      .select()
      .from(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, [a.id, b.id]));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(a.id);
    expect(remaining[0].usdPerImage).toBe(0.04);
  });

  it("does not touch distinct models or providers", async () => {
    const [a] = await db
      .insert(aiModelPricesTable)
      .values({ kind: "text", provider: "builtin", model: `${RUN}-distinct-a`, inputUsdPerMtok: 1, outputUsdPerMtok: 2 })
      .returning();
    const [b] = await db
      .insert(aiModelPricesTable)
      .values({ kind: "text", provider: "builtin", model: `${RUN}-distinct-b`, inputUsdPerMtok: 3, outputUsdPerMtok: 4 })
      .returning();
    createdPriceIds.push(a.id, b.id);

    const merges = await dedupeModelPrices();
    expect(merges.some((m) => m.keptId === a.id || m.keptId === b.id)).toBe(false);
    const remaining = await db
      .select()
      .from(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, [a.id, b.id]));
    expect(remaining).toHaveLength(2);
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
      usdPerSecond: null,
      usdPerVideo: null,
    });
    expect(await deleteModelPrice(price.id)).toBe(true);
    expect(await deleteModelPrice(price.id)).toBe(false);
  });
});
