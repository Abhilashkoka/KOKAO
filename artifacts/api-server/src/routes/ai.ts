import dns from "node:dns/promises";
import net from "node:net";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, brandKitsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

async function loadTenant(tenantId: number) {
  return (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
}

async function loadBrandKit(tenantId: number, brandKitId: number | null | undefined) {
  if (!brandKitId) return undefined;
  return (
    await db
      .select()
      .from(brandKitsTable)
      .where(and(eq(brandKitsTable.id, brandKitId), eq(brandKitsTable.tenantId, tenantId)))
      .limit(1)
  )[0];
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

  const brandKit = await loadBrandKit(req.tenantId, parsed.data.brandKitId ?? null);
  const platform = parsed.data.platform ?? "instagram";
  const tone = parsed.data.tone ?? brandKit?.voice ?? "friendly and engaging";

  const guidance: string[] = [
    `You are an expert social media copywriter. Write a ${platform} caption.`,
    `Tone/voice: ${tone}.`,
  ];
  if (brandKit) {
    guidance.push(`Brand name: ${brandKit.name}.`);
    if (brandKit.hashtags.length > 0) {
      guidance.push(`Prefer these brand hashtags when relevant: ${brandKit.hashtags.join(", ")}.`);
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

  const brandKit = await loadBrandKit(req.tenantId, parsed.data.brandKitId ?? null);
  const size = parsed.data.size ?? "1024x1024";

  let prompt = parsed.data.prompt;
  if (brandKit) {
    prompt += `. Brand palette: ${brandKit.primaryColor}, ${brandKit.secondaryColor}, ${brandKit.accentColor}. Cohesive with a ${brandKit.voice || "modern"} brand aesthetic.`;
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

const MAX_FETCH_BYTES = 2_000_000;
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: string, bits: number) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) ||
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) ||
    inRange("224.0.0.0", 4) ||
    inRange("240.0.0.0", 4)
  );
}

function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);

  // Convert a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hex groups.
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    if (idx < 0) return null;
    const v4 = s.slice(idx + 1);
    if (!net.isIPv4(v4)) return null;
    const o = v4.split(".").map(Number);
    const g1 = ((o[0] << 8) | o[1]).toString(16);
    const g2 = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, idx + 1) + g1 + ":" + g2;
  }

  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const headParts = dbl[0] ? dbl[0].split(":") : [];
  const tailParts = dbl.length === 2 ? (dbl[1] ? dbl[1].split(":") : []) : null;

  let groups: number[];
  if (tailParts === null) {
    if (headParts.length !== 8) return null;
    groups = headParts.map((h) => parseInt(h, 16));
  } else {
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) return null;
    groups = [
      ...headParts.map((h) => parseInt(h, 16)),
      ...Array(missing).fill(0),
      ...tailParts.map((h) => parseInt(h, 16)),
    ];
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

function isPrivateIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable -> block (fail closed)

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, deprecated):
  // delegate the embedded IPv4 to the IPv4 checks (also catches ::, ::1).
  const isMapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const isCompat = b.slice(0, 12).every((x) => x === 0);
  if (isMapped || isCompat) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    if (isPrivateIPv4(v4)) return true;
  }

  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  const first = b[0];
  if ((first & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (first === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (first === 0xff) return true; // multicast ff00::/8
  return false;
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("Blocked host");
    return;
  }
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    throw new Error("Blocked host");
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (addrs.length === 0) throw new Error("Blocked host");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("Blocked host");
  }
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

async function safeFetch(initialUrl: string, signal: AbortSignal): Promise<FetchResponse> {
  let url = initialUrl;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Blocked protocol");
    }
    await assertPublicHost(parsed.hostname);
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

async function readCappedText(res: FetchResponse, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        chunks.push(Buffer.from(value.slice(0, value.length - (total - maxBytes))));
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

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

  const brandKit = await loadBrandKit(req.tenantId, parsed.data.brandKitId ?? null);

  const guidance: string[] = [
    "You are a social media strategist.",
    "Generate exactly 5 engaging, trending, and original text-based social media post topic ideas for the given niche.",
    "Keep each idea short, catchy, and scroll-stopping. Do not number them. Do not suggest video ideas.",
  ];
  if (brandKit) {
    guidance.push(`Bias ideas toward this brand voice: ${brandKit.voice || "modern"}.`);
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

  const brandKit = await loadBrandKit(req.tenantId, parsed.data.brandKitId ?? null);
  const tone = parsed.data.tone ?? brandKit?.voice ?? "friendly and engaging";

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
  if (brandKit) {
    guidance.push(`Brand name: ${brandKit.name}.`);
    guidance.push(
      `Incorporate the brand palette (${brandKit.primaryColor}, ${brandKit.secondaryColor}, ${brandKit.accentColor}) into each image prompt.`,
    );
    if (brandKit.hashtags.length > 0) {
      guidance.push(`Prefer these brand hashtags when relevant: ${brandKit.hashtags.join(", ")}.`);
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
