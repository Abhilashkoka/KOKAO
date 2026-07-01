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
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { getPlanLimits } from "../lib/plans";
import { getUsage, recordUsage } from "../lib/usage";
import { loadActivePayload } from "../lib/brandKit/service";
import {
  safeFetch,
  readCappedText,
  htmlToText,
  ALLOWED_CONTENT_TYPES,
  MAX_FETCH_BYTES,
} from "../lib/webFetch";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

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

  const limits = getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.captions !== -1 && usage.captions >= limits.captions) {
    res.status(402).json({ error: "Monthly caption quota reached. Upgrade your plan to continue." });
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

    await recordUsage(req.tenantId, "caption");
    res.json({ caption, hashtags });
  } catch (error) {
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

  const limits = getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.images !== -1 && usage.images >= limits.images) {
    res.status(402).json({ error: "Monthly image quota reached. Upgrade your plan to continue." });
    return;
  }

  const brand = await loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null);
  const size = parsed.data.size ?? "1024x1024";

  let prompt = parsed.data.prompt;
  if (brand) {
    const palette = colorHint(brand);
    const imagery = brand.visual_style.imagery_style.slice(0, 3).join(", ");
    if (palette) prompt += `. Brand palette: ${palette}.`;
    if (imagery) prompt += ` Imagery style: ${imagery}.`;
    prompt += ` Cohesive with a ${voiceHint(brand)} brand aesthetic.`;
  }

  try {
    const buffer = await generateImageBuffer(prompt, size);

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(buffer),
    });
    if (!putRes.ok) {
      throw new Error(`Upload failed with status ${putRes.status}`);
    }
    const imagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    await recordUsage(req.tenantId, "image");
    res.json({ imagePath, b64Json: buffer.toString("base64") });
  } catch (error) {
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

  const limits = getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.captions !== -1 && usage.captions + platforms.length > limits.captions) {
    res.status(402).json({
      error: "This campaign would exceed your monthly caption quota. Upgrade your plan or pick fewer platforms.",
    });
    return;
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

    await Promise.all(platforms.map(() => recordUsage(req.tenantId, "caption")));
    res.json({ posts });
  } catch (error) {
    req.log.error({ err: error }, "Campaign generation failed");
    res.status(500).json({ error: "Failed to generate campaign" });
  }
});

export default router;
