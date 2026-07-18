import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, type BrandKitPayload } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai, generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import {
  GenerateCaptionBody,
  GenerateImageBody,
  SuggestTopicsBody,
  SummarizeUrlBody,
  GenerateCampaignBody,
  ResearchTopicBody,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { getPlanLimits } from "../lib/plans";
import { getUsage, recordUsage } from "../lib/usage";
import { spendCredit, refundCredits, type CreditKind } from "../lib/credits";
import { loadActivePayload } from "../lib/brandKit/service";
import { isDesignSkillEnabledFor, buildDesignedImagePrompt } from "../lib/designSkill";
import { buildTasteGuidance } from "../lib/tasteMemory";
import multer from "multer";
import {
  transcribeAudio,
  AsrNotConfiguredError,
  AsrProviderError,
} from "../lib/asr";
import {
  safeFetch,
  readCappedText,
  htmlToText,
  ALLOWED_CONTENT_TYPES,
  MAX_FETCH_BYTES,
} from "../lib/webFetch";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

/**
 * How a metered generation is paid for: the monthly plan quota first, then
 * prepaid credits when the quota is exhausted.
 *
 * Credits are RESERVED (atomically debited) up front, before the expensive
 * generation runs, so two concurrent requests can never both consume the
 * same last credit — the second reservation fails and gets a 402. If the
 * generation then fails, the reservation is refunded (audited in the
 * ledger). Quota-funded work is metered after success as before.
 */
type Funding = "quota" | "credit";

async function reserveFunding(
  tenantId: number,
  limit: number,
  used: number,
  kind: CreditKind,
): Promise<Funding | null> {
  if (limit === -1 || used < limit) return "quota";
  const reserved = await spendCredit(tenantId, kind);
  return reserved ? "credit" : null;
}

/** Record the cost of a successful quota-funded generation. */
async function settleFunding(
  req: Request,
  funding: Funding,
  kind: CreditKind,
): Promise<void> {
  // Credit-funded work was already debited at reservation time.
  if (funding === "quota") await recordUsage(req.tenantId, kind);
}

/** Return a reserved credit when the funded generation failed. */
async function releaseFunding(
  req: Request,
  funding: Funding,
  kind: CreditKind,
): Promise<void> {
  if (funding !== "credit") return;
  try {
    await refundCredits(req.tenantId, kind, 1, `${kind} generation failed`);
  } catch (error) {
    req.log.error({ err: error, kind }, "Failed to refund reserved credit");
  }
}

async function loadTenant(tenantId: number) {
  return (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
}

/** Resolve the active brand payload for an optional brand id, or null. */
async function loadBrandPayload(
  tenantId: number,
  brandKitId: number | null | undefined,
): Promise<BrandKitPayload | null> {
  const resolved = await loadActivePayload(tenantId, brandKitId);
  return resolved?.payload ?? null;
}

/** Flatten every brand color into a short, comma-joined hint for prompts. */
function colorHint(payload: BrandKitPayload): string {
  const colors = [
    ...payload.colors.primary,
    ...payload.colors.secondary,
    ...payload.colors.neutral,
  ]
    .map((c) => c.hex)
    .filter(Boolean)
    .slice(0, 6);
  return colors.join(", ");
}

/** A concise voice descriptor from the brand payload for prompt injection. */
function voiceHint(payload: BrandKitPayload): string {
  const traits = payload.voice.traits.filter(Boolean).slice(0, 5);
  if (traits.length > 0) return traits.join(", ");
  return payload.voice.caption_style || "modern";
}

router.post("/ai/generate-caption", async (req: Request, res: Response) => {
  const parsed = GenerateCaptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  // Plan quota first; when it is gone, prepaid credits take over. 402 only
  // when BOTH are exhausted.
  const captionFunding = await reserveFunding(
    req.tenantId,
    limits.captions,
    usage.captions,
    "caption",
  );
  if (!captionFunding) {
    res.status(402).json({
      error:
        "Monthly caption quota reached and no caption credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  const brand = await loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null);
  const platform = parsed.data.platform ?? "instagram";
  const tone = parsed.data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");

  const guidance: string[] = [
    `You are an expert social media copywriter. Write a ${platform} caption.`,
    `Tone/voice: ${tone}.`,
  ];
  if (brand) {
    guidance.push(`Brand name: ${brand.identity.brand_name}.`);
    if (brand.identity.tagline) guidance.push(`Tagline: ${brand.identity.tagline}.`);
    if (brand.voice.dos.length > 0) {
      guidance.push(`Voice do's: ${brand.voice.dos.slice(0, 5).join("; ")}.`);
    }
    if (brand.voice.donts.length > 0) {
      guidance.push(`Voice don'ts: ${brand.voice.donts.slice(0, 5).join("; ")}.`);
    }
    if (brand.brand_controls.restricted_terms.length > 0) {
      guidance.push(
        `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
      );
    }
  }
  // Taste memory: learned preferences are soft guidance appended AFTER the
  // brand kit rules, so brand rules and the user's explicit prompt still win.
  const taste = await buildTasteGuidance(req.tenantId);
  guidance.push(...taste.captionLines);
  guidance.push(
    'Respond ONLY with strict JSON of the form {"caption": string, "hashtags": string[]}. ' +
      "Hashtags must not include the # symbol. Provide 5-12 relevant hashtags.",
  );

  try {
    const completion = await openai.chat.completions.create({
      model: tenant.aiModel,
      messages: [
        { role: "system", content: guidance.join(" ") },
        { role: "user", content: parsed.data.prompt },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let caption = "";
    let hashtags: string[] = [];
    try {
      const obj = JSON.parse(raw) as { caption?: string; hashtags?: unknown };
      caption = typeof obj.caption === "string" ? obj.caption : "";
      hashtags = Array.isArray(obj.hashtags)
        ? obj.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
        : [];
    } catch {
      caption = raw;
    }

    await settleFunding(req, captionFunding, "caption");
    res.json({ caption, hashtags });
  } catch (error) {
    await releaseFunding(req, captionFunding, "caption");
    req.log.error({ err: error }, "Caption generation failed");
    res.status(500).json({ error: "Failed to generate caption" });
  }
});

router.post("/ai/generate-image", async (req: Request, res: Response) => {
  const parsed = GenerateImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  const imageFunding = await reserveFunding(
    req.tenantId,
    limits.images,
    usage.images,
    "image",
  );
  if (!imageFunding) {
    res.status(402).json({
      error:
        "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  const brand = await loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null);
  const size = parsed.data.size ?? "1024x1024";

  // Base prompt (also the fallback if the design skill is off or fails):
  // the user's brief plus lightweight brand hints.
  let prompt = parsed.data.prompt;
  if (brand) {
    const palette = colorHint(brand);
    const imagery = brand.visual_style.imagery_style.slice(0, 3).join(", ");
    if (palette) prompt += `. Brand palette: ${palette}.`;
    if (imagery) prompt += ` Imagery style: ${imagery}.`;
    prompt += ` Cohesive with a ${voiceHint(brand)} brand aesthetic.`;
  }

  // Taste memory: soft style hint from previously approved image prompts.
  const imageTaste = await buildTasteGuidance(req.tenantId);
  if (imageTaste.imageHint) prompt += imageTaste.imageHint;

  // Canvas-design skill: when enabled, a text-model pass first writes a design
  // philosophy and compiles it into an art-directed prompt (brand elements are
  // mandatory input when a brand kit applies). Fails soft to the base prompt.
  if (await isDesignSkillEnabledFor(tenant)) {
    const designed = await buildDesignedImagePrompt({
      model: tenant.aiModel,
      userPrompt: parsed.data.prompt,
      brand,
      fallbackPrompt: prompt,
    });
    prompt = designed.imagePrompt;
    if (designed.enriched) {
      req.log.info(
        { philosophy: designed.philosophy },
        "Design skill enriched image prompt",
      );
    }
  }

  try {
    const buffer = await generateImageBuffer(prompt, size);

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(req.tenantId);
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(30_000),
    });
    if (!putRes.ok) {
      throw new Error(`Upload failed with status ${putRes.status}`);
    }
    const imagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    await settleFunding(req, imageFunding, "image");
    res.json({ imagePath, b64Json: buffer.toString("base64") });
  } catch (error) {
    await releaseFunding(req, imageFunding, "image");
    req.log.error({ err: error }, "Image generation failed");
    res.status(500).json({ error: "Failed to generate image" });
  }
});

const PLATFORM_STYLES: Record<string, string> = {
  facebook:
    "Facebook: appeal to a broad demographic, conversational and engagement-driven, can be slightly longer.",
  instagram:
    "Instagram: younger audience that values authenticity and creativity, punchy and visual, emoji-friendly.",
  linkedin:
    "LinkedIn: professional and polished, B2B tone, insight-led, credible and value-driven.",
  twitter:
    "X (Twitter): bold, concise, and punchy; high-contrast hook; keep it short and scroll-stopping.",
};

const PLATFORM_IMAGE_STYLES: Record<string, string> = {
  facebook:
    "optimized for Facebook's broad demographic, attention-grabbing and high quality, square-friendly composition",
  instagram:
    "optimized for Instagram, strong single focal point, authentic and creative, vibrant and modern",
  linkedin:
    "optimized for LinkedIn, polished corporate look, refined and professional, clean B2B aesthetic with generous white space",
  twitter:
    "optimized for X (Twitter), bold high-contrast visuals, minimal text, clean and modern, eye-catching in a fast feed",
};

router.post("/ai/suggest-topics", async (req: Request, res: Response) => {
  const parsed = SuggestTopicsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const brand = await loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null);

  const guidance: string[] = [
    "You are a social media strategist.",
    "Generate exactly 5 engaging, trending, and original text-based social media post topic ideas for the given niche.",
    "Keep each idea short, catchy, and scroll-stopping. Do not number them. Do not suggest video ideas.",
  ];
  if (brand) {
    guidance.push(`Bias ideas toward this brand voice: ${voiceHint(brand)}.`);
    if (brand.identity.audience.length > 0) {
      guidance.push(`Target audience: ${brand.identity.audience.slice(0, 3).join(", ")}.`);
    }
  }
  guidance.push('Respond ONLY with strict JSON of the form {"ideas": string[]} with exactly 5 items.');

  try {
    const completion = await openai.chat.completions.create({
      model: tenant.aiModel,
      messages: [
        { role: "system", content: guidance.join(" ") },
        { role: "user", content: `Niche/idea: ${parsed.data.niche}` },
      ],
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let ideas: string[] = [];
    try {
      const obj = JSON.parse(raw) as { ideas?: unknown };
      ideas = Array.isArray(obj.ideas)
        ? obj.ideas.map((i) => String(i).trim()).filter(Boolean).slice(0, 5)
        : [];
    } catch {
      ideas = [];
    }

    res.json({ ideas });
  } catch (error) {
    req.log.error({ err: error }, "Topic suggestion failed");
    res.status(500).json({ error: "Failed to suggest topics" });
  }
});

router.post("/ai/summarize-url", async (req: Request, res: Response) => {
  const parsed = SummarizeUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsed.data.url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    res.status(400).json({ error: "Please provide a valid http(s) URL." });
    return;
  }

  let text = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const fetchRes = await safeFetch(parsedUrl.toString(), controller.signal);
    if (!fetchRes.ok) {
      res.status(422).json({ error: `Could not fetch the URL (status ${fetchRes.status}).` });
      return;
    }
    const contentType = (fetchRes.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t))) {
      res.status(422).json({ error: "That URL is not a readable web page." });
      return;
    }
    const html = await readCappedText(fetchRes, MAX_FETCH_BYTES);
    text = htmlToText(html).slice(0, 12000);
  } catch (error) {
    req.log.error({ err: error }, "URL fetch failed");
    res.status(422).json({ error: "Could not fetch or read that URL." });
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (text.length < 100) {
    res.status(422).json({ error: "Could not extract enough readable content from that URL." });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: tenant.aiModel,
      messages: [
        {
          role: "system",
          content:
            "You are an expert summarizer. Read the article content and extract the most important, factual, neutral information. " +
            "Capture the main arguments, data points, and conclusions in clear, concise paragraphs. Ignore ads, author bios, and navigation. " +
            'Also produce a short title (max 8 words, no special characters). Respond ONLY with strict JSON of the form {"title": string, "summary": string}.',
        },
        { role: "user", content: `Article content:\n${text}` },
      ],
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let title = "";
    let summary = "";
    try {
      const obj = JSON.parse(raw) as { title?: unknown; summary?: unknown };
      title = typeof obj.title === "string" ? obj.title : "";
      summary = typeof obj.summary === "string" ? obj.summary : "";
    } catch {
      summary = raw;
    }

    if (!summary) {
      res.status(422).json({ error: "Could not summarize that URL." });
      return;
    }

    res.json({ title, summary });
  } catch (error) {
    req.log.error({ err: error }, "URL summarization failed");
    res.status(500).json({ error: "Failed to summarize URL" });
  }
});

router.post("/ai/research", async (req: Request, res: Response) => {
  const parsed = ResearchTopicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const brand = await loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null);

  const guidance: string[] = [
    "You are a social media research analyst. Use web search to find CURRENT, factual information about the given topic.",
    "Search the web, then write a concise research brief grounded ONLY in what you found. Do not invent facts.",
    "Prefer recent, reputable sources. Include concrete data points, dates, and named developments when available.",
  ];
  if (brand) {
    if (brand.identity.audience.length > 0) {
      guidance.push(
        `Frame findings for this target audience: ${brand.identity.audience.slice(0, 3).join(", ")}.`,
      );
    }
    guidance.push(`Bias suggested post angles toward this brand voice: ${voiceHint(brand)}.`);
  }
  guidance.push(
    "Respond ONLY with strict JSON of the form " +
      '{"summary": string, "keyFindings": string[], "suggestedAngles": string[]}. ' +
      "summary: 2-3 short paragraphs. keyFindings: 3-6 specific, factual bullet points. " +
      "suggestedAngles: 3-5 social post angles derived from the findings. " +
      "Do not include markdown, citations markers, or a sources list in the JSON; sources are collected separately.",
  );

  try {
    const response = await openai.responses.create({
      model: "gpt-5.4",
      tools: [{ type: "web_search" }],
      instructions: guidance.join(" "),
      input: `Research topic: ${parsed.data.topic}`,
      max_output_tokens: 4096,
    });

    // Collect sources from the model's URL citations, deduped by URL.
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const item of response.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type !== "output_text") continue;
        for (const annotation of part.annotations ?? []) {
          if (annotation.type !== "url_citation") continue;
          const url = annotation.url ?? "";
          if (!url || seen.has(url)) continue;
          // Only pass through http(s) links; drop any odd schemes.
          try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
          } catch {
            continue;
          }
          seen.add(url);
          sources.push({ title: annotation.title || url, url });
        }
      }
    }

    const raw = response.output_text ?? "";
    let summary = "";
    let keyFindings: string[] = [];
    let suggestedAngles: string[] = [];
    try {
      // The model may wrap JSON in prose; extract the outermost object.
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
      const obj = JSON.parse(jsonText) as {
        summary?: unknown;
        keyFindings?: unknown;
        suggestedAngles?: unknown;
      };
      summary = typeof obj.summary === "string" ? obj.summary : "";
      keyFindings = Array.isArray(obj.keyFindings)
        ? obj.keyFindings.map((f) => String(f).trim()).filter(Boolean).slice(0, 6)
        : [];
      suggestedAngles = Array.isArray(obj.suggestedAngles)
        ? obj.suggestedAngles.map((a) => String(a).trim()).filter(Boolean).slice(0, 5)
        : [];
    } catch {
      summary = raw.trim();
    }

    if (!summary) {
      res.status(422).json({ error: "Research produced no usable results. Try a more specific topic." });
      return;
    }

    res.json({ summary, keyFindings, sources: sources.slice(0, 8), suggestedAngles });
  } catch (error) {
    req.log.error({ err: error }, "Web research failed");
    res.status(500).json({ error: "Failed to research that topic" });
  }
});

router.post("/ai/generate-campaign", async (req: Request, res: Response) => {
  const parsed = GenerateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const platforms = Array.from(
    new Set(parsed.data.platforms.map((p) => p.toLowerCase().trim()).filter(Boolean)),
  );
  if (platforms.length === 0) {
    res.status(400).json({ error: "Select at least one platform." });
    return;
  }

  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  // A campaign costs one caption per platform. Cover as much as possible from
  // the remaining plan quota, then top up from prepaid credits; 402 only when
  // the two together cannot cover the whole campaign.
  let quotaFunded = platforms.length;
  let creditFunded = 0;
  if (limits.captions !== -1) {
    const remainingQuota = Math.max(0, limits.captions - usage.captions);
    quotaFunded = Math.min(platforms.length, remainingQuota);
    creditFunded = platforms.length - quotaFunded;
    if (creditFunded > 0) {
      // Reserve every credit-funded unit atomically (all-or-nothing) BEFORE
      // generating, so concurrent campaigns cannot over-consume credits. The
      // reservation is refunded if generation fails.
      const reserved = await spendCredit(req.tenantId, "caption", creditFunded);
      if (!reserved) {
        res.status(402).json({
          error:
            "This campaign would exceed your monthly caption quota and you don't have enough caption credits. Upgrade your plan, buy a credit pack, or pick fewer platforms.",
        });
        return;
      }
    }
  }

  const brand = await loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null);
  const tone = parsed.data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");

  const styleLines = platforms.map(
    (p) => `- ${p}: caption style -> ${PLATFORM_STYLES[p] ?? p}; image style -> ${PLATFORM_IMAGE_STYLES[p] ?? "high quality, on-brand"}.`,
  );

  const guidance: string[] = [
    "You are a senior social media strategist and expert copywriter.",
    `Write one tailored post for EACH of these platforms: ${platforms.join(", ")}.`,
    `Overall tone/voice: ${tone}.`,
    "Tailor each caption to its platform's audience and format. For each platform also write a concise, descriptive AI image-generation prompt that complements the caption.",
    "Platform guidance:",
    styleLines.join(" "),
  ];
  if (brand) {
    guidance.push(`Brand name: ${brand.identity.brand_name}.`);
    const palette = colorHint(brand);
    if (palette) {
      guidance.push(`Incorporate the brand palette (${palette}) into each image prompt.`);
    }
    if (brand.brand_controls.restricted_terms.length > 0) {
      guidance.push(
        `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
      );
    }
  }
  guidance.push(
    'Respond ONLY with strict JSON of the form {"posts": [{"platform": string, "caption": string, "hashtags": string[], "imagePrompt": string}]}. ' +
      "Include one object per requested platform, using the exact platform identifiers given. Hashtags must not include the # symbol; provide 5-12 per post.",
  );

  try {
    const completion = await openai.chat.completions.create({
      model: tenant.aiModel,
      messages: [
        { role: "system", content: guidance.join(" ") },
        { role: "user", content: parsed.data.prompt },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let postsRaw: unknown[] = [];
    try {
      const obj = JSON.parse(raw) as { posts?: unknown };
      postsRaw = Array.isArray(obj.posts) ? obj.posts : [];
    } catch {
      postsRaw = [];
    }

    const byPlatform = new Map<string, { caption: string; hashtags: string[]; imagePrompt: string }>();
    for (const item of postsRaw) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const platform = String(o.platform ?? "").toLowerCase().trim();
      if (!platform) continue;
      byPlatform.set(platform, {
        caption: typeof o.caption === "string" ? o.caption : "",
        hashtags: Array.isArray(o.hashtags)
          ? o.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
          : [],
        imagePrompt: typeof o.imagePrompt === "string" ? o.imagePrompt : "",
      });
    }

    const posts = platforms.map((platform) => {
      const found = byPlatform.get(platform);
      return {
        platform,
        caption: found?.caption ?? "",
        hashtags: found?.hashtags ?? [],
        imagePrompt: found?.imagePrompt ?? "",
      };
    });

    // Credit-funded captions were already debited at reservation time; only
    // the quota-funded share is metered here.
    await Promise.all(
      Array.from({ length: quotaFunded }, () => recordUsage(req.tenantId, "caption")),
    );
    res.json({ posts });
  } catch (error) {
    if (creditFunded > 0) {
      try {
        await refundCredits(
          req.tenantId,
          "caption",
          creditFunded,
          "campaign generation failed",
        );
      } catch (refundError) {
        req.log.error({ err: refundError }, "Failed to refund reserved campaign credits");
      }
    }
    req.log.error({ err: error }, "Campaign generation failed");
    res.status(500).json({ error: "Failed to generate campaign" });
  }
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "video/webm",
  "video/mp4",
]);

/**
 * POST /ai/transcribe
 * Transcribe a short voice note using the platform-selected ASR provider.
 * Unmetered helper (like suggest-topics); rate-limited by aiLimiter.
 */
router.post(
  "/ai/transcribe",
  audioUpload.single("audio"),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || file.size === 0) {
      res.status(400).json({ error: "No audio file uploaded (field name: audio)" });
      return;
    }
    const mimeType = (file.mimetype || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(mimeType)) {
      res.status(400).json({ error: `Unsupported audio type: ${mimeType || "unknown"}` });
      return;
    }
    try {
      const result = await transcribeAudio({
        buffer: file.buffer,
        mimeType,
        filename: file.originalname || "voice-note.webm",
      });
      res.json(result);
    } catch (error) {
      if (error instanceof AsrNotConfiguredError) {
        res.status(502).json({ error: error.message });
        return;
      }
      if (error instanceof AsrProviderError) {
        req.log.error({ err: error }, "Transcription provider failed");
        res.status(502).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "Transcription failed");
      res.status(502).json({ error: "Transcription failed" });
    }
  },
);

export default router;
