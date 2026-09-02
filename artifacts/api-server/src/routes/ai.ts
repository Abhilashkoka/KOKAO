import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { parseModelJsonObject } from "../lib/modelJson";
export { parseModelJsonObject } from "../lib/modelJson";
import {
  db,
  tenantsTable,
  contentItemsTable,
  guidedStoryDraftsTable,
  type BrandKitPayload,
  type GuidedStoryImageModelSnapshot,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  generateImage,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
} from "../lib/imageGen";
import { compileImagePrompt } from "../lib/imageGen/promptCompiler";
import {
  performImageEdit,
  loadSourceImage,
  decodeMask,
  assertMaskMatchesSource,
  ImageEditInputError,
  ImageEditModerationError,
} from "../lib/imageEdit";
import {
  runImageOp,
  ImageOpError,
  OP_UNITS,
  type ImageOp,
} from "../lib/imageEditor/ops";
import {
  EditImageBody,
  RunImageOpBody,
  GenerateCaptionBody,
  GenerateHooksBody,
  GenerateImageBody,
  GeneratePlatformPackBody,
  SuggestTopicsBody,
  SummarizeUrlBody,
  GenerateCampaignBody,
  GenerateCarouselBody,
  ResearchTopicBody,
  LocalizeScriptBody,
} from "@workspace/api-zod";
import {
  DEFAULT_VOICE_PROFILE,
  isTargetLocale,
  localePolicy,
  toSrt,
  toVtt,
  type BrandVoiceProfile,
  type SubtitleCue,
  type TargetLocale,
} from "@workspace/localization";
import {
  transcreateCues,
  MAX_SOURCE_CUES,
} from "../lib/localization/transcreate";
import { ObjectStorageService } from "../lib/objectStorage";
import { getPlanLimits } from "../lib/plans";
import {
  getUsage,
  recordUsage,
  releaseQuotaUsage,
  reserveQuotaUsage,
  startQuotaUsageLease,
  settleQuotaUsage,
  type QuotaUsageReservation,
  type UsageMeta,
} from "../lib/usage";
import { spendCredit, refundCredits, type CreditKind } from "../lib/credits";
import {
  isWalletFunded,
  reserveWallet,
  settleWallet,
  refundWallet,
  type WalletReservation,
} from "../lib/wallet";
import { loadActivePayload } from "../lib/brandKit/service";
import {
  isDesignSkillEnabledFor,
  buildDesignedImagePrompt,
} from "../lib/designSkill";
import {
  loadReferenceImage,
  buildReferenceGuide,
  ReferenceImageError,
} from "../lib/referenceGuide";
import { isFeatureEnabled, requireFeature } from "../lib/featureFlags";
import { applyMadeWithWatermark } from "../lib/watermark";
import { getTextGenClient, listTenantModelChoices } from "../lib/textGen";
import { lookupOpenRouterPricing } from "../lib/openrouterCatalog";
import { lookupReplicateTokenPricing } from "../lib/replicateCatalog";
import { TextGenNotConfiguredError, type TextGenClient } from "../lib/textGen";
import { buildTasteGuidance } from "../lib/tasteMemory";
import {
  getGovernedPrompt,
  logCompiledPrompt,
  type GovernedPrompt,
} from "../lib/promptKit";
import { performImageGeneration } from "../lib/imageGeneration";
import {
  buildTextCostMeta,
  buildImageCostMeta,
  usageAccountingParams,
  streamUsageParams,
  type CompletionUsageLike,
} from "../lib/aiCost";
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
 * How a metered generation is paid for.
 *
 * Two rails, and a workspace is on exactly one of them:
 *   quota → credit   the original path: the monthly plan quota first, then
 *                    prepaid unit credits when the quota is exhausted
 *   wallet           the prepaid rupee wallet, when the `wallet` platform
 *                    switch is on AND this workspace is set to wallet mode
 *
 * Either way funding is RESERVED (atomically debited) up front, before the
 * expensive generation runs, so two concurrent requests can never both
 * consume the same last credit or the same last rupee — the second
 * reservation fails and gets a 402. If the generation then fails, the
 * reservation is released/refunded. Finite quota uses a pending usage-ledger
 * row so the hold remains visible after the reservation transaction commits.
 *
 * A wallet reservation is an ESTIMATE. It settles to the real provider cost
 * plus the platform fee in `settleFunding`, once the provider has reported
 * back — see lib/wallet.ts.
 */
interface Funding {
  source: "quota" | "credit" | "wallet";
  reservation?: WalletReservation;
  quotaReservation?: QuotaUsageReservation;
  stopQuotaLease?: () => void;
  /**
   * Set the moment the generation is treated as successful. `releaseFunding`
   * refuses to refund afterwards, so a failure in the metering that FOLLOWS a
   * settled charge can never hand the money back on top of it.
   */
  resolved?: boolean;
}

async function reserveFunding(
  tenantId: number,
  limit: number,
  kind: CreditKind,
): Promise<Funding | null> {
  if (await isWalletFunded(tenantId)) {
    const reservation = await reserveWallet(tenantId, kind);
    return reservation ? { source: "wallet", reservation } : null;
  }
  if (limit === -1) return { source: "quota" };
  const quotaReservation = await reserveQuotaUsage(tenantId, kind, limit);
  if (quotaReservation) {
    return {
      source: "quota",
      quotaReservation,
      stopQuotaLease: startQuotaUsageLease(tenantId, quotaReservation),
    };
  }
  const reserved = await spendCredit(tenantId, kind);
  return reserved ? { source: "credit" } : null;
}

/**
 * The 402 message for an exhausted workspace, phrased for the rail it is
 * actually on: "recharge" for wallet workspaces, "upgrade or buy credits"
 * for everyone else.
 */
async function outOfFundsMessage(
  tenantId: number,
  kind: CreditKind,
  quotaMessage: string,
): Promise<string> {
  if (await isWalletFunded(tenantId)) {
    return `Your wallet balance can't cover this ${kind}. Recharge to continue.`;
  }
  return quotaMessage;
}

/**
 * Record the cost of a successful generation.
 *
 * Quota-funded work counts against the plan. Credit-funded work was already
 * debited at reservation time. Wallet-funded work settles here: the up-front
 * estimate is trued up to the real provider cost (`meta.costPaise`, from the
 * same cost engine that powers the Actual Cost Report) plus the platform fee.
 * Every rail still gets a usage row so AI data consumption is metered for
 * every generation; credit and wallet rows are excluded from quota counting.
 */
async function settleFunding(
  req: Request,
  funding: Funding,
  kind: CreditKind,
  meta: Omit<UsageMeta, "funding"> & { refKind?: string; refId?: string } = {},
): Promise<number | null> {
  // Point of no return: the work succeeded, so nothing after this may refund.
  funding.resolved = true;
  funding.stopQuotaLease?.();
  if (funding.source === "wallet" && funding.reservation) {
    try {
      await settleWallet(req.tenantId, funding.reservation, {
        kind,
        costPaise: meta.costPaise ?? null,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
        inputTokens: meta.inputTokens ?? null,
        outputTokens: meta.outputTokens ?? null,
        refKind: meta.refKind ?? null,
        refId: meta.refId ?? null,
      });
    } catch (error) {
      // The estimate is already debited, so a settle failure overcharges or
      // undercharges by the difference rather than losing the whole charge.
      req.log.error({ err: error, kind }, "Failed to settle wallet charge");
    }
  }
  // Metering is best-effort and must not throw into the caller's catch block:
  // there it would look like a failed generation and trigger a refund of a
  // charge that has already been settled. Returns the snapshotted display
  // amount (paise) recorded for this event, so routes can hand the REAL
  // per-generation spend back to the client; null when metering failed.
  try {
    if (funding.source === "quota" && funding.quotaReservation) {
      return await settleQuotaUsage(
        req.tenantId,
        funding.quotaReservation,
        kind,
        meta,
      );
    }
    return await recordUsage(req.tenantId, kind, {
      ...meta,
      funding: funding.source,
    });
  } catch (error) {
    req.log.error(
      { err: error, kind },
      "Failed to record usage after settling",
    );
    return null;
  }
}

/**
 * Ledger link for a charge made on behalf of an existing library item.
 * The id comes from the client, so it only counts when the item really
 * belongs to this workspace — anything else is silently dropped (the link is
 * a convenience label, never worth failing a paid generation over).
 */
async function contentRef(
  tenantId: number,
  contentId: number | null | undefined,
): Promise<{ refKind?: string; refId?: string }> {
  if (!contentId) return {};
  try {
    const row = (
      await db
        .select({ id: contentItemsTable.id })
        .from(contentItemsTable)
        .where(
          and(
            eq(contentItemsTable.id, contentId),
            eq(contentItemsTable.tenantId, tenantId),
          ),
        )
        .limit(1)
    )[0];
    return row ? { refKind: "content", refId: String(row.id) } : {};
  } catch {
    return {};
  }
}

/** Return the reserved funding when the generation failed. */
async function releaseFunding(
  req: Request,
  funding: Funding,
  kind: CreditKind,
): Promise<void> {
  if (funding.resolved) return;
  funding.resolved = true;
  funding.stopQuotaLease?.();
  try {
    if (funding.source === "credit") {
      await refundCredits(req.tenantId, kind, 1, `${kind} generation failed`);
    } else if (funding.source === "quota" && funding.quotaReservation) {
      await releaseQuotaUsage(req.tenantId, funding.quotaReservation);
    } else if (funding.source === "wallet" && funding.reservation) {
      await refundWallet(
        req.tenantId,
        funding.reservation,
        `${kind} generation failed`,
      );
    }
  } catch (error) {
    req.log.error({ err: error, kind }, "Failed to refund reserved funding");
  }
}

async function loadTenant(tenantId: number) {
  const row = (
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
  // aiModel is kept raw here: the text-gen routing layer maps it to a model
  // the ACTIVE provider serves (retired/unknown names fall back safely).
  return row;
}

/**
 * The routed text-gen client for this tenant, or null after responding 503
 * when OpenRouter is selected but not configured (clear error, no silent
 * fallback to the built-in provider).
 */
async function getTextGenOrRespond(
  res: Response,
  tenantModel: string,
): Promise<TextGenClient | null> {
  try {
    return await getTextGenClient(tenantModel);
  } catch (err) {
    if (err instanceof TextGenNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

/**
 * GET /ai/models
 * The text-model choices this tenant's Settings dropdown should offer under
 * the ACTIVE platform-wide text generation provider.
 */
router.get("/ai/models", async (_req: Request, res: Response) => {
  const choices = await listTenantModelChoices();
  // Decorate external-provider choices with live catalog pricing (fail-soft:
  // null prices when the public catalog is unreachable).
  if (choices.provider === "openrouter") {
    res.json({
      ...choices,
      pricing: await lookupOpenRouterPricing(choices.models),
    });
    return;
  }
  if (choices.provider === "replicate") {
    res.json({
      ...choices,
      pricing: await lookupReplicateTokenPricing(choices.models),
    });
    return;
  }
  res.json(choices);
});

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

/**
 * Practical caption capacity per platform, used to decide which platform
 * gets the master (longest) draft first. Values mirror lib/social-limits
 * where a hard limit exists (twitter 280, threads 500, linkedin 3000) plus
 * well-known platform caps for the rest.
 */
const PLATFORM_CAPACITY: Record<string, number> = {
  facebook: 63206,
  youtube: 5000,
  linkedin: 3000,
  instagram: 2200,
  threads: 500,
  twitter: 280,
};

/**
 * Assemble a system prompt following the RICE framework: Role, Instruction,
 * Context, Examples, Constraints, and Output Format — clearly labeled
 * sections instead of one run-on string.
 */
function buildRicePrompt(sections: {
  role: string;
  instruction: string[];
  context: string[];
  examples: string[];
  constraints: string[];
  outputFormat: string[];
}): string {
  const parts: string[] = [`ROLE:\n${sections.role}`];
  const block = (label: string, lines: string[]) => {
    if (lines.length > 0)
      parts.push(`${label}:\n${lines.map((l) => `- ${l}`).join("\n")}`);
  };
  block("INSTRUCTION", sections.instruction);
  block("CONTEXT", sections.context);
  block("CONSTRAINTS", sections.constraints);
  // Examples (taste-memory style preferences) are soft guidance and must
  // come AFTER the hard brand constraints so brand rules always win.
  block(
    "EXAMPLES (soft style preferences; the constraints above always win)",
    sections.examples,
  );
  block("OUTPUT FORMAT", sections.outputFormat);
  return parts.join("\n\n");
}

/** Shared humanization + expert-voice rules applied to every caption prompt. */
const HUMAN_EXPERT_CONSTRAINTS: string[] = [
  "Write like a real human expert in this field, not like an AI. Vary sentence length, use natural rhythm, and sound like someone who has hands-on experience with the subject.",
  'Never use AI-sounding filler: no "In today\'s fast-paced world", "unlock", "elevate", "game-changer", "delve", "revolutionize", "seamless", or openings like "Imagine...". No exclamation-mark spam.',
  "No generic content. Every claim must be specific to the topic — concrete details, numbers, or insider observations an expert would actually know. If a sentence could be pasted under any other topic, rewrite it.",
  "Speak with the authority of a practitioner: give a point of view, not a summary.",
];

/**
 * Shared clarify rule: when the brief is too thin to write something
 * effective, the model must ask for the missing input instead of guessing.
 */
const CLARIFY_RULE =
  "First judge whether the brief gives you enough to write an effective, specific post (a clear topic plus at least some angle, audience, offer, or goal). " +
  'If it does NOT, do not write generic content — instead respond ONLY with strict JSON {"clarifyingQuestions": string[]} containing 2-4 short, concrete questions (in plain language) about exactly what input you need from the user.';

/** Parse an optional clarifyingQuestions array out of a raw model object. */
function parseClarifyingQuestions(obj: unknown): string[] | null {
  if (!obj || typeof obj !== "object") return null;
  const q = (obj as Record<string, unknown>).clarifyingQuestions;
  if (!Array.isArray(q)) return null;
  const questions = q
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 6);
  return questions.length > 0 ? questions : null;
}

/**
 * Assemble the RICE system prompt for a single-caption request. The brand
 * lookup and taste-memory read are independent, so they run in parallel.
 * Shared by the JSON and the SSE streaming caption endpoints.
 */
async function buildCaptionSystemPrompt(
  tenantId: number,
  data: {
    platform?: string | null;
    tone?: string | null;
    brandKitId?: number | null;
  },
  clerkUserId?: string | null,
): Promise<{
  systemPrompt: string;
  platform: string;
  governed: GovernedPrompt | null;
}> {
  const [brand, taste] = await Promise.all([
    loadBrandPayload(tenantId, data.brandKitId ?? null),
    // Taste memory: learned preferences are soft guidance placed under
    // Examples, AFTER the brand kit rules, so brand rules and the user's
    // explicit prompt still win.
    buildTasteGuidance(tenantId),
  ]);
  const platform = data.platform ?? "instagram";
  const tone =
    data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");

  const context: string[] = [
    `Target platform: ${platform}.`,
    `Tone/voice: ${tone}.`,
  ];
  const constraints: string[] = [...HUMAN_EXPERT_CONSTRAINTS];
  if (brand) {
    context.push(`Brand name: ${brand.identity.brand_name}.`);
    if (brand.identity.tagline)
      context.push(`Brand tagline: ${brand.identity.tagline}.`);
    if (brand.voice.dos.length > 0) {
      constraints.push(
        `Voice do's: ${brand.voice.dos.slice(0, 5).join("; ")}.`,
      );
    }
    if (brand.voice.donts.length > 0) {
      constraints.push(
        `Voice don'ts: ${brand.voice.donts.slice(0, 5).join("; ")}.`,
      );
    }
    if (brand.brand_controls.restricted_terms.length > 0) {
      constraints.push(
        `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
      );
    }
  }

  const outputFormat = [
    'Respond ONLY with strict JSON of the form {"title": string, "caption": string, "hashtags": string[]}.',
    "Hashtags must not include the # symbol. Provide 5-12 relevant hashtags.",
    'If (and only if) the brief is too thin, respond instead with {"clarifyingQuestions": string[]}.',
  ];

  // Prompt Template Kit: when an admin has published a production template
  // for the caption flow, it replaces the built-in RICE prompt (the JSON
  // output contract and runtime context are appended so parsing never
  // breaks). Fail-open: null keeps the prompt below exactly as before.
  if (clerkUserId) {
    const governed = await getGovernedPrompt({
      flowKey: "caption",
      tenantId,
      clerkUserId,
      runtimeContext: [...context, ...constraints].join("\n"),
      outputFormat: [CLARIFY_RULE, ...outputFormat].join("\n"),
      placeholderValues: { platform, tone },
    });
    if (governed) {
      return { systemPrompt: governed.text, platform, governed };
    }
  }

  const systemPrompt = buildRicePrompt({
    role: `You are a senior ${platform} copywriter with a decade of hands-on experience writing high-performing posts in this exact niche.`,
    instruction: [
      CLARIFY_RULE,
      `Otherwise, write one ${platform} caption based on the user's creative brief, plus a short creative-brief title (3-8 words) naming the idea.`,
    ],
    context,
    examples: taste.captionLines,
    constraints,
    outputFormat,
  });
  return { systemPrompt, platform, governed: null };
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
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

  const limits = await getPlanLimits(tenant.plan);
  // Plan quota first; when it is gone, prepaid credits take over. 402 only
  // when BOTH are exhausted.
  const captionFunding = await reserveFunding(
    req.tenantId,
    limits.captions,
    "caption",
  );
  if (!captionFunding) {
    res.status(402).json({
      error: await outOfFundsMessage(
        req.tenantId,
        "caption",
        "Monthly caption quota reached and no caption credits left. Upgrade your plan or buy a credit pack.",
      ),
    });
    return;
  }

  const { systemPrompt, platform, governed } = await buildCaptionSystemPrompt(
    req.tenantId,
    parsed.data,
    req.clerkUserId,
  );

  const startedAt = Date.now();
  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: parsed.data.prompt },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let caption = "";
    let title = "";
    let hashtags: string[] = [];
    let clarifyingQuestions: string[] | null = null;
    try {
      const parsedObj = parseModelJsonObject(raw);
      if (!parsedObj) {
        // Unrecoverable output: fall back to the raw text, as before.
        caption = raw;
      } else {
        const obj = parsedObj as {
          caption?: string;
          title?: string;
          hashtags?: unknown;
        };
        clarifyingQuestions = parseClarifyingQuestions(obj);
        caption = typeof obj.caption === "string" ? obj.caption : "";
        title = typeof obj.title === "string" ? obj.title : "";
        hashtags = Array.isArray(obj.hashtags)
          ? obj.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
          : [];
      }
    } catch {
      caption = raw;
    }

    // The model asked for more input instead of generating content: return
    // the questions and give back the reserved funding — nothing was made.
    if (clarifyingQuestions && !caption) {
      await releaseFunding(req, captionFunding, "caption");
      res.json({ caption: "", hashtags: [], clarifyingQuestions });
      return;
    }

    // Unusable output (e.g. the model answered "{}" or an empty caption
    // string): charge nothing — release the reservation and report failure,
    // mirroring the campaign routes' "no usable posts" guard.
    if (!caption.trim()) {
      await releaseFunding(req, captionFunding, "caption");
      if (governed) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "caption",
          governed,
          generationContext: { platform, model: textGen.model },
          success: false,
          latencyMs: Date.now() - startedAt,
        });
      }
      req.log.error("Caption generation returned no usable caption text");
      res.status(500).json({ error: "Failed to generate caption" });
      return;
    }

    const spendPaise = await settleFunding(req, captionFunding, "caption", {
      requestBytes: Buffer.byteLength(systemPrompt + parsed.data.prompt),
      responseBytes: Buffer.byteLength(raw),
      durationMs: Date.now() - startedAt,
      model: textGen.model,
      platform,
      ...(await buildTextCostMeta(completion, textGen)),
      ...(await contentRef(req.tenantId, parsed.data.contentId)),
    });
    if (governed) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "caption",
        governed,
        generationContext: { platform, model: textGen.model },
        success: true,
        latencyMs: Date.now() - startedAt,
        tokenUsage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens ?? 0,
              completionTokens: completion.usage.completion_tokens ?? 0,
              totalTokens: completion.usage.total_tokens ?? 0,
            }
          : null,
      });
    }
    res.json({
      caption,
      hashtags,
      ...(title ? { title } : {}),
      ...(spendPaise !== null ? { spendPaise } : {}),
    });
  } catch (error) {
    await releaseFunding(req, captionFunding, "caption");
    if (governed) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "caption",
        governed,
        generationContext: { platform, model: textGen.model },
        success: false,
        latencyMs: Date.now() - startedAt,
      });
    }
    req.log.error({ err: error }, "Caption generation failed");
    res.status(500).json({ error: "Failed to generate caption" });
  }
});

/**
 * Incrementally extract the value of the "caption" string field from a
 * partially received JSON document, so caption text can be streamed to the
 * client word-by-word while the model is still emitting the rest of the JSON.
 * Returns the caption text decoded so far (unescaped) and whether the closing
 * quote has been seen.
 */
export function extractPartialCaption(raw: string): {
  text: string;
  done: boolean;
} {
  const keyMatch = /"caption"\s*:\s*"/.exec(raw);
  if (!keyMatch) return { text: "", done: false };
  let out = "";
  let i = keyMatch.index + keyMatch[0].length;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break; // escape split across chunks; wait
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) out += String.fromCharCode(code);
        i += 6;
        continue;
      } else out += next;
      i += 2;
      continue;
    }
    if (ch === '"') return { text: out, done: true };
    out += ch;
    i += 1;
  }
  return { text: out, done: false };
}

/**
 * POST /ai/generate-caption/stream — the SSE variant of caption generation.
 *
 * Contract: funding is reserved BEFORE the stream starts (same 402 rules).
 * Events are SSE `data:` lines of JSON:
 *   {type:"delta", text}      — newly available caption text
 *   {type:"result", caption, hashtags, title?, clarifyingQuestions?} — final
 *   {type:"error", message}   — terminal failure
 * Funding settles on a successful result, and is released on clarify, error,
 * or client disconnect mid-stream. The JSON endpoint above stays unchanged
 * for mobile and any non-SSE client.
 */
router.post(
  "/ai/generate-caption/stream",
  async (req: Request, res: Response) => {
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
    const textGen = await getTextGenOrRespond(res, tenant.aiModel);
    if (!textGen) return;

    const limits = await getPlanLimits(tenant.plan);
    const captionFunding = await reserveFunding(
      req.tenantId,
      limits.captions,
      "caption",
    );
    if (!captionFunding) {
      res.status(402).json({
        error: await outOfFundsMessage(
          req.tenantId,
          "caption",
          "Monthly caption quota reached and no caption credits left. Upgrade your plan or buy a credit pack.",
        ),
      });
      return;
    }

    const { systemPrompt, platform, governed } = await buildCaptionSystemPrompt(
      req.tenantId,
      parsed.data,
      req.clerkUserId,
    );

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Exactly one funding settlement per request, no matter how the stream
    // ends (result, clarify, error, or the client going away mid-stream).
    let fundingResolved = false;
    const releaseOnce = async () => {
      if (fundingResolved) return;
      fundingResolved = true;
      await releaseFunding(req, captionFunding, "caption");
    };

    const startedAt = Date.now();
    let raw = "";
    let sent = 0;
    // Whether any NON-whitespace caption text has been delivered to the client.
    // Whitespace-only deltas don't count as usable output, so they must never
    // turn an empty caption into a charge.
    let usableSent = false;
    // Streamed usage arrives on a final chunk that carries no content, and TTFT
    // can only be measured here — by the time the stream is drained the number
    // is gone. Both stay unset if the client disconnects first.
    let streamUsage: CompletionUsageLike = {};
    let ttftMs: number | null = null;
    // The event's snapshotted display amount, captured at settle so the final
    // result event can carry the REAL spend for this generation.
    let settledSpendPaise: number | null = null;
    const settleOnce = async () => {
      if (fundingResolved) return;
      fundingResolved = true;
      settledSpendPaise = await settleFunding(req, captionFunding, "caption", {
        requestBytes: Buffer.byteLength(systemPrompt + parsed.data.prompt),
        responseBytes: Buffer.byteLength(raw),
        durationMs: Date.now() - startedAt,
        model: textGen.model,
        platform,
        ...(ttftMs === null ? {} : { ttftMs }),
        ...(await buildTextCostMeta(streamUsage, textGen)),
        ...(await contentRef(req.tenantId, parsed.data.contentId)),
      });
    };

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        // Client disconnected mid-stream: stop paying the model. If caption
        // text was already delivered via deltas, the generation was consumed —
        // settle it (refunding here would let clients read the caption and
        // disconnect before the final event to dodge the charge). Only refund
        // when nothing usable was delivered.
        abort.abort();
        if (usableSent) {
          void settleOnce();
        } else {
          void releaseOnce();
        }
      }
    });

    try {
      const stream = await textGen.client.chat.completions.create(
        {
          model: textGen.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: parsed.data.prompt },
          ],
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          stream: true,
          ...usageAccountingParams(textGen.provider),
          ...streamUsageParams(),
        },
        { signal: abort.signal },
      );

      for await (const chunk of stream) {
        if (chunk.usage) streamUsage = { usage: chunk.usage };
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (!delta) continue;
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        raw += delta;
        const partial = extractPartialCaption(raw);
        if (partial.text.length > sent) {
          send({ type: "delta", text: partial.text.slice(sent) });
          sent = partial.text.length;
          if (partial.text.trim().length > 0) usableSent = true;
        }
      }

      let caption = "";
      let title = "";
      let hashtags: string[] = [];
      let clarifyingQuestions: string[] | null = null;
      try {
        const parsedObj = parseModelJsonObject(raw);
        if (!parsedObj) {
          // Unrecoverable output: fall back to the raw text, as before.
          caption = raw;
        } else {
          const obj = parsedObj as {
            caption?: string;
            title?: string;
            hashtags?: unknown;
          };
          clarifyingQuestions = parseClarifyingQuestions(obj);
          caption = typeof obj.caption === "string" ? obj.caption : "";
          title = typeof obj.title === "string" ? obj.title : "";
          hashtags = Array.isArray(obj.hashtags)
            ? obj.hashtags
                .map((h) => String(h).replace(/^#/, ""))
                .filter(Boolean)
            : [];
        }
      } catch {
        caption = raw;
      }

      if (clarifyingQuestions && !caption) {
        await releaseOnce();
        send({
          type: "result",
          caption: "",
          hashtags: [],
          clarifyingQuestions,
        });
        res.end();
        return;
      }

      // Unusable output: charge nothing. Only when no USABLE (non-whitespace)
      // caption text was ever delivered — if the client already received real
      // caption text, the generation was consumed and the charge must still
      // settle (same policy as the disconnect handler above).
      if (!caption.trim() && !usableSent) {
        await releaseOnce();
        if (governed) {
          await logCompiledPrompt({
            tenantId: req.tenantId,
            clerkUserId: req.clerkUserId,
            flowKey: "caption",
            governed,
            generationContext: {
              platform,
              model: textGen.model,
              streamed: true,
            },
            success: false,
            latencyMs: Date.now() - startedAt,
          });
        }
        req.log.error(
          "Streaming caption generation returned no usable caption text",
        );
        send({ type: "error", message: "Failed to generate caption" });
        res.end();
        return;
      }

      await settleOnce();
      if (governed) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "caption",
          governed,
          generationContext: { platform, model: textGen.model, streamed: true },
          success: true,
          latencyMs: Date.now() - startedAt,
          tokenUsage: streamUsage.usage
            ? {
                promptTokens: streamUsage.usage.prompt_tokens ?? 0,
                completionTokens: streamUsage.usage.completion_tokens ?? 0,
                // Streamed usage payloads don't include total_tokens; derive it.
                totalTokens:
                  (streamUsage.usage.prompt_tokens ?? 0) +
                  (streamUsage.usage.completion_tokens ?? 0),
              }
            : null,
        });
      }
      send({
        type: "result",
        caption,
        hashtags,
        ...(title ? { title } : {}),
        ...(settledSpendPaise !== null
          ? { spendPaise: settledSpendPaise }
          : {}),
      });
      res.end();
    } catch (error) {
      await releaseOnce();
      // A client can disconnect after receiving a usable caption delta. That
      // is still a successful governed generation: the disconnect handler
      // settles its funding, and the audit trace must not disappear merely
      // because the upstream stream was aborted.
      const deliveredBeforeDisconnect = abort.signal.aborted && usableSent;
      if (governed && (!abort.signal.aborted || deliveredBeforeDisconnect)) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "caption",
          governed,
          generationContext: { platform, model: textGen.model, streamed: true },
          success: deliveredBeforeDisconnect,
          latencyMs: Date.now() - startedAt,
        });
      }
      if (!abort.signal.aborted) {
        req.log.error({ err: error }, "Streaming caption generation failed");
      }
      send({ type: "error", message: "Failed to generate caption" });
      res.end();
    }
  },
);

/**
 * Merge a caller-supplied voice profile over the defaults.
 *
 * Every field is optional on the wire so a client can send only what it wants
 * to override, but the transcreation prompt needs a complete profile — an
 * empty register or a missing brand name would quietly produce generic copy.
 */
function mergeVoiceProfile(
  input:
    | NonNullable<ReturnType<typeof LocalizeScriptBody.parse>["voiceProfile"]>
    | undefined,
): BrandVoiceProfile {
  if (!input) return DEFAULT_VOICE_PROFILE;
  return {
    brandName: input.brandName?.trim() || DEFAULT_VOICE_PROFILE.brandName,
    register: input.register?.trim() || DEFAULT_VOICE_PROFILE.register,
    stance: input.stance ?? DEFAULT_VOICE_PROFILE.stance,
    rhythm: input.rhythm?.trim() || DEFAULT_VOICE_PROFILE.rhythm,
    humour: input.humour?.trim() || DEFAULT_VOICE_PROFILE.humour,
    antiList: input.antiList ?? DEFAULT_VOICE_PROFILE.antiList,
    // The brand name is untranslatable whether or not the caller remembered
    // to list it, so it is unioned in rather than overwritten.
    keepLatin: Array.from(
      new Set([
        ...(input.keepLatin ?? []),
        input.brandName?.trim() || DEFAULT_VOICE_PROFILE.brandName,
      ]),
    ),
    uiStrings: input.uiStrings ?? [],
    uiIsLocalized: input.uiIsLocalized ?? false,
  };
}

/**
 * Transcreate a timed English script into Telugu, Tamil, or Hindi.
 *
 * One caption credit per target language, reserved up front like every other
 * metered generation. A language whose model call fails is refunded on its own
 * — a Tamil timeout must not cost the user their Hindi track.
 *
 * Synchronous rather than a job: this is a handful of chat completions, in the
 * same shape and duration as caption generation. Rendering video in these
 * languages is the long-running half and lives on the video job runner.
 */
router.post("/ai/localize-script", async (req: Request, res: Response) => {
  const parsed = LocalizeScriptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const locales: TargetLocale[] = Array.from(
    new Set(parsed.data.locales),
  ).filter(isTargetLocale);
  if (locales.length === 0) {
    res.status(400).json({ error: "Pick at least one target language." });
    return;
  }

  if (parsed.data.cues.length > MAX_SOURCE_CUES) {
    res.status(400).json({
      error: `That script has ${parsed.data.cues.length} lines. The maximum is ${MAX_SOURCE_CUES}.`,
    });
    return;
  }

  const cues = parsed.data.cues.map((cue) => ({
    index: cue.index,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text.trim(),
  }));

  const badCue = cues.find(
    (cue) => cue.endMs <= cue.startMs || cue.text.length === 0,
  );
  if (badCue) {
    res.status(400).json({
      error: `Line ${badCue.index} has no text or ends before it starts. Fix the timings and try again.`,
    });
    return;
  }

  const seenCueIndexes = new Set<number>();
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    if (seenCueIndexes.has(cue.index)) {
      res.status(400).json({
        error: `Line number ${cue.index} appears more than once. Use a unique number for every cue.`,
      });
      return;
    }
    seenCueIndexes.add(cue.index);

    const previous = i > 0 ? cues[i - 1] : undefined;
    if (previous && cue.startMs < previous.endMs) {
      res.status(400).json({
        error: `Line ${cue.index} starts before line ${previous.index} ends. Fix the overlapping timings and try again.`,
      });
      return;
    }
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

  const profile = mergeVoiceProfile(parsed.data.voiceProfile);
  const limits = await getPlanLimits(tenant.plan);

  // Reserve one caption unit per language before any model call. Finite quota
  // slots are durable usage-ledger holds, so concurrent requests cannot both
  // claim the tenant's last slot before either model returns.
  const reservations: { locale: TargetLocale; funding: Funding }[] = [];
  for (const locale of locales) {
    const funding = await reserveFunding(
      req.tenantId,
      limits.captions,
      "caption",
    );
    if (!funding) {
      for (const held of reservations)
        await releaseFunding(req, held.funding, "caption");
      res.status(402).json({
        error: await outOfFundsMessage(
          req.tenantId,
          "caption",
          `Not enough caption quota or credits for ${locales.length} language${locales.length === 1 ? "" : "s"}. Upgrade your plan or buy a credit pack.`,
        ),
      });
      return;
    }
    reservations.push({ locale, funding });
  }

  const ref = await contentRef(req.tenantId, parsed.data.contentId);
  const completed: {
    locale: TargetLocale;
    result: Awaited<ReturnType<typeof transcreateCues>>;
    durationMs: number;
  }[] = [];
  let spendPaise: number | null = null;

  for (const { locale } of reservations) {
    const startedAt = Date.now();
    try {
      const result = await transcreateCues({
        cues,
        locale,
        profile,
        client: textGen.client,
        model: textGen.model,
        requestParams: usageAccountingParams(textGen.provider),
        childrenContent: parsed.data.childrenContent ?? false,
      });

      // Nothing usable came back for any line: charge nothing for this
      // language rather than billing for an empty track.
      if (result.cues.every((cue) => cue.text.length === 0)) {
        req.log.error({ locale }, "Transcreation returned no usable lines");
        continue;
      }

      completed.push({ locale, result, durationMs: Date.now() - startedAt });
    } catch (error) {
      req.log.error({ err: error, locale }, "Transcreation failed");
    }
  }

  if (completed.length === 0) {
    for (const held of reservations)
      await releaseFunding(req, held.funding, "caption");
    res
      .status(500)
      .json({ error: "Could not localize this script. Please try again." });
    return;
  }

  // Funding reservations are fungible within this one request. Assign quota
  // slots to successful tracks first, then prepaid credits/wallet holds. This
  // matters when an early quota-backed locale fails but a later locale
  // succeeds: the success should consume the still-available quota slot, not a
  // prepaid credit merely because of request order.
  const fundingPool = reservations
    .map(({ funding }) => funding)
    .sort((a, b) => (a.source === "quota" ? -1 : b.source === "quota" ? 1 : 0));
  const tracks: unknown[] = [];

  for (const { locale, result, durationMs } of completed) {
    const funding = fundingPool.shift()!;
    const subtitleCues: SubtitleCue[] = result.cues
      .filter((cue) => cue.text.length > 0)
      .map((cue) => ({
        index: cue.index,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
      }));

    const settled = await settleFunding(req, funding, "caption", {
      requestBytes: Buffer.byteLength(result.systemPrompt),
      responseBytes: Buffer.byteLength(result.rawResponse),
      durationMs,
      model: textGen.model,
      ...ref,
    });
    if (settled !== null) spendPaise = (spendPaise ?? 0) + settled;

    tracks.push({
      locale,
      label: localePolicy(locale).label,
      blocked: result.blocked,
      cues: result.cues,
      trackIssues: result.trackIssues,
      srt: toSrt(subtitleCues),
      vtt: toVtt(subtitleCues),
    });
  }

  for (const unused of fundingPool)
    await releaseFunding(req, unused, "caption");

  res.json({ tracks, ...(spendPaise !== null ? { spendPaise } : {}) });
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

  const guidedStoryDraftId = parsed.data.guidedStoryDraftId;
  const guidedStoryRevision = parsed.data.guidedStoryRevision;
  if ((guidedStoryDraftId === undefined) !== (guidedStoryRevision === undefined)) {
    res.status(400).json({
      error: "guidedStoryDraftId and guidedStoryRevision must be supplied together.",
    });
    return;
  }
  let selectionPolicy: GuidedStoryImageModelSnapshot | undefined;
  if (guidedStoryDraftId !== undefined && guidedStoryRevision !== undefined) {
    const draft = (
      await db
        .select({
          revision: guidedStoryDraftsTable.revision,
          state: guidedStoryDraftsTable.state,
        })
        .from(guidedStoryDraftsTable)
        .where(
          and(
            eq(guidedStoryDraftsTable.id, guidedStoryDraftId),
            eq(guidedStoryDraftsTable.tenantId, req.tenantId),
          ),
        )
        .limit(1)
    )[0];
    // Tenant-scoped lookup avoids disclosing another tenant's draft.
    if (!draft) {
      res.status(404).json({ error: "Guided Story draft not found." });
      return;
    }
    if (draft.revision !== guidedStoryRevision) {
      res.status(409).json({
        error: "This Guided Story draft changed. Reload it before generating.",
      });
      return;
    }
    if (!draft.state.imageModelSnapshot) {
      res.status(409).json({
        error:
          "This Guided Story draft has no frozen image selection. Create a new draft before generating a backdrop.",
      });
      return;
    }
    selectionPolicy = draft.state.imageModelSnapshot;
  }

  // Reference image (optional): kill-switch gated, tenant-scope asserted, and
  // loaded BEFORE any funding is reserved so a bad upload never burns quota.
  const referenceImagePath = parsed.data.referenceImagePath ?? null;
  let referenceImage = null;
  if (referenceImagePath) {
    if (!(await isFeatureEnabled("referenceImages"))) {
      res.status(403).json({
        error: "Reference images are currently disabled by the administrator.",
        code: "feature_disabled",
      });
      return;
    }
    try {
      referenceImage = await loadReferenceImage(
        referenceImagePath,
        req.tenantId,
      );
    } catch (error) {
      if (error instanceof ReferenceImageError) {
        res.status(400).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "Failed to load reference image");
      res.status(500).json({ error: "Failed to load the reference image" });
      return;
    }
  }

  const limits = await getPlanLimits(tenant.plan);
  const imageFunding = await reserveFunding(
    req.tenantId,
    limits.images,
    "image",
  );
  if (!imageFunding) {
    res.status(402).json({
      error: await outOfFundsMessage(
        req.tenantId,
        "image",
        "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
      ),
    });
    return;
  }

  const size = parsed.data.size ?? "1024x1024";

  // Prompt Template Kit: a production template for the image flow wraps the
  // typed prompt in the admin's governed guidance (plain text — image
  // providers never see JSON). Fail-open: null sends the prompt as before.
  const compiledUserPrompt = compileImagePrompt(
    parsed.data.prompt,
    // Kill switch: when Image Look Presets is off, the recipe is dropped
    // and the prompt goes out exactly as typed. Fail-open on flag reads.
    (await isFeatureEnabled("imageLooks").catch(() => true))
      ? parsed.data.promptRecipe
      : undefined,
  );
  const imageGoverned = await getGovernedPrompt({
    flowKey: "image",
    tenantId: req.tenantId,
    clerkUserId: req.clerkUserId,
    userInput: compiledUserPrompt,
  });

  const genStartedAt = Date.now();
  try {
    // Shared pipeline: parallel prompt passes (taste, design skill or the
    // precompiled brand style, reference guide) -> provider -> watermark ->
    // storage. See lib/imageGeneration.ts.
    const outcome = await performImageGeneration({
      tenantId: req.tenantId,
      tenant,
      userPrompt: imageGoverned ? imageGoverned.text : compiledUserPrompt,
      size,
      brandKitId: parsed.data.brandKitId ?? null,
      referenceImage,
      selectionPolicy,
    });
    if (imageGoverned) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "image",
        governed: imageGoverned,
        generationContext: { size, platform: parsed.data.platform ?? null },
        success: true,
        latencyMs: Date.now() - genStartedAt,
      });
    }

    const spendPaise = await settleFunding(req, imageFunding, "image", {
      ...outcome.meta,
      campaignId: parsed.data.campaignId ?? undefined,
      platform: parsed.data.platform ?? undefined,
      ...(await contentRef(req.tenantId, parsed.data.contentId)),
      ...(parsed.data.contentId == null && parsed.data.campaignId
        ? { refKind: "campaign", refId: parsed.data.campaignId }
        : {}),
    });
    res.json({
      imagePath: outcome.imagePath,
      b64Json: outcome.b64Json,
      ...(spendPaise !== null ? { spendPaise } : {}),
    });
  } catch (error) {
    await releaseFunding(req, imageFunding, "image");
    req.log.error({ err: error }, "Image generation failed");
    if (imageGoverned) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "image",
        governed: imageGoverned,
        generationContext: { size, platform: parsed.data.platform ?? null },
        success: false,
        latencyMs: Date.now() - genStartedAt,
      });
    }
    if (error instanceof ImageGenNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof ImageGenProviderError) {
      res.status(502).json({
        error:
          "The image provider rejected the request. Try again or contact your admin.",
      });
      return;
    }
    res.status(500).json({ error: "Failed to generate image" });
  }
});

router.post("/ai/edit-image", async (req: Request, res: Response) => {
  const parsed = EditImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Source image + mask are validated BEFORE any funding is reserved so a
  // bad path or mask never burns quota. The loader asserts tenant ownership.
  let source;
  try {
    source = await loadSourceImage(parsed.data.imagePath, req.tenantId);
    const mask = decodeMask(parsed.data.maskB64);
    await assertMaskMatchesSource(mask, source.buffer);
  } catch (error) {
    if (
      error instanceof ReferenceImageError ||
      error instanceof ImageEditInputError
    ) {
      res
        .status(400)
        .json({ error: error.message.replace("Reference image", "Image") });
      return;
    }
    req.log.error({ err: error }, "Failed to load image for editing");
    res.status(500).json({ error: "Failed to load the image to edit" });
    return;
  }

  // Billed exactly like one image generation (wallet/quota/credit).
  const limits = await getPlanLimits(tenant.plan);
  const imageFunding = await reserveFunding(
    req.tenantId,
    limits.images,
    "image",
  );
  if (!imageFunding) {
    res.status(402).json({
      error: await outOfFundsMessage(
        req.tenantId,
        "image",
        "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
      ),
    });
    return;
  }

  try {
    const outcome = await performImageEdit({
      tenantId: req.tenantId,
      tenant,
      sourceBuffer: source.buffer,
      sourceMimeType: source.mimeType,
      maskB64: parsed.data.maskB64,
      prompt: parsed.data.prompt,
    });
    const spendPaise = await settleFunding(req, imageFunding, "image", {
      ...outcome.meta,
      ...(await contentRef(req.tenantId, parsed.data.contentId)),
    });
    res.json({
      imagePath: outcome.imagePath,
      b64Json: outcome.b64Json,
      ...(spendPaise !== null ? { spendPaise } : {}),
    });
  } catch (error) {
    await releaseFunding(req, imageFunding, "image");
    req.log.error({ err: error }, "Image edit failed");
    if (error instanceof ImageEditModerationError) {
      res.status(422).json({ error: error.message });
      return;
    }
    if (error instanceof ImageGenNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof ImageGenProviderError) {
      res.status(502).json({
        error:
          "The image provider rejected the edit. Try again or contact your admin.",
      });
      return;
    }
    res.status(500).json({ error: "Failed to edit image" });
  }
});

/**
 * The editor's generative tools.
 *
 * A sibling of /ai/edit-image rather than its own router, because it needs the
 * same funding rails (reserve before, settle or release after) that live in
 * this module, and because it inherits this router's rate limit and aiStudio
 * feature gate by sitting under the same /ai prefix.
 *
 * Two things are deliberately ordered the way they are:
 *
 *  - Validation of the source and the mask happens BEFORE funding is reserved,
 *    so a bad path or a mismatched mask is a 400 rather than a spent credit.
 *  - `enlarge` costs nothing and reserves nothing. Reserving zero units would
 *    still take the wallet lock and write a ledger row for an operation that
 *    never leaves the server.
 */
router.post("/ai/image-op", async (req: Request, res: Response) => {
  const parsed = RunImageOpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const op = parsed.data.op as ImageOp;
  const maskOps: ImageOp[] = ["fill", "remove", "replace-background"];

  let source;
  try {
    source = await loadSourceImage(parsed.data.imagePath, req.tenantId);
    if (maskOps.includes(op)) {
      if (!parsed.data.maskB64) {
        res.status(400).json({ error: "Select an area on the image first." });
        return;
      }
      const mask = decodeMask(parsed.data.maskB64);
      await assertMaskMatchesSource(mask, source.buffer);
    }
  } catch (error) {
    if (
      error instanceof ReferenceImageError ||
      error instanceof ImageEditInputError
    ) {
      res
        .status(400)
        .json({ error: error.message.replace("Reference image", "Image") });
      return;
    }
    req.log.error(
      { err: error },
      "Failed to load image for an editor operation",
    );
    res.status(500).json({ error: "Failed to load the image" });
    return;
  }

  const units = OP_UNITS[op] ?? 1;
  let funding: Awaited<ReturnType<typeof reserveFunding>> = null;
  if (units > 0) {
    const limits = await getPlanLimits(tenant.plan);
    funding = await reserveFunding(req.tenantId, limits.images, "image");
    if (!funding) {
      res.status(402).json({
        error: await outOfFundsMessage(
          req.tenantId,
          "image",
          "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
        ),
      });
      return;
    }
  }

  try {
    const outcome = await runImageOp({
      op,
      tenantId: req.tenantId,
      tenant,
      sourceBuffer: source.buffer,
      sourceMimeType: source.mimeType,
      maskB64: parsed.data.maskB64 ?? null,
      prompt: parsed.data.prompt ?? null,
      pad: parsed.data.pad ?? null,
      scale: parsed.data.scale ?? null,
    });

    if (funding && outcome.meta) {
      await settleFunding(req, funding, "image", {
        ...outcome.meta,
        ...(await contentRef(req.tenantId, parsed.data.contentId)),
      });
    } else if (funding) await releaseFunding(req, funding, "image");

    res.json({
      imagePath: outcome.imagePath,
      b64Json: outcome.b64Json,
      width: outcome.width,
      height: outcome.height,
      sourceBox: outcome.sourceBox,
      layers: outcome.layers,
      units: outcome.units,
    });
  } catch (error) {
    if (funding) await releaseFunding(req, funding, "image");
    if (error instanceof ImageEditModerationError) {
      res.status(422).json({ error: error.message });
      return;
    }
    if (error instanceof ImageOpError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof ImageGenNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof ImageGenProviderError) {
      res.status(502).json({
        error:
          "The image provider rejected the edit. Try again or contact your admin.",
      });
      return;
    }
    req.log.error({ err: error }, "Editor image operation failed");
    res.status(500).json({ error: "Failed to run the operation" });
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
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

  const brand = await loadBrandPayload(
    req.tenantId,
    parsed.data.brandKitId ?? null,
  );

  const guidance: string[] = [
    "You are a social media strategist.",
    "Generate exactly 5 engaging, trending, and original text-based social media post topic ideas for the given niche.",
    "Keep each idea short, catchy, and scroll-stopping. Do not number them. Do not suggest video ideas.",
  ];
  if (brand) {
    guidance.push(`Bias ideas toward this brand voice: ${voiceHint(brand)}.`);
    if (brand.identity.audience.length > 0) {
      guidance.push(
        `Target audience: ${brand.identity.audience.slice(0, 3).join(", ")}.`,
      );
    }
  }
  guidance.push(
    'Respond ONLY with strict JSON of the form {"ideas": string[]} with exactly 5 items.',
  );

  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
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
      const obj = (parseModelJsonObject(raw) ?? {}) as { ideas?: unknown };
      ideas = Array.isArray(obj.ideas)
        ? obj.ideas
            .map((i) => String(i).trim())
            .filter(Boolean)
            .slice(0, 5)
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

/** The six proven hook patterns the hook writer rotates through. */
const HOOK_STYLES = [
  {
    key: "question",
    hint: "A question the target viewer can't not answer in their head.",
  },
  {
    key: "bold-claim",
    hint: "A confident, specific claim that raises the stakes immediately.",
  },
  {
    key: "contrarian",
    hint: "Challenge the common advice everyone in this niche repeats.",
  },
  {
    key: "curiosity",
    hint: "Open a specific curiosity gap the viewer must stay to close.",
  },
  { key: "stat", hint: "Lead with one startling, concrete number or fact." },
  { key: "story", hint: "Drop the viewer mid-story at the most tense moment." },
] as const;

/**
 * POST /ai/generate-hooks — 5 first-three-seconds hook variants in distinct
 * proven styles. Free helper (like suggest-topics): one small completion.
 */
router.post("/ai/generate-hooks", async (req: Request, res: Response) => {
  const parsed = GenerateHooksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;
  const brand = await loadBrandPayload(
    req.tenantId,
    parsed.data.brandKitId ?? null,
  );

  const styleList = HOOK_STYLES.map((s) => `${s.key}: ${s.hint}`).join("\n- ");
  const systemPrompt = buildRicePrompt({
    role: "You write the first three seconds of high-performing short-form social videos. Your hooks decide whether people stop scrolling.",
    instruction: [
      "Write exactly 5 opening hooks for the given topic, each using a DIFFERENT one of these patterns:",
      styleList,
      "Each hook is 1-2 short spoken sentences (max ~20 words) meant to be said out loud at the start of a video.",
    ],
    context: brand
      ? [
          `Brand voice: ${voiceHint(brand)}.`,
          ...(brand.identity.audience.length > 0
            ? [
                `Target audience: ${brand.identity.audience.slice(0, 3).join(", ")}.`,
              ]
            : []),
        ]
      : [],
    examples: [],
    constraints: [...HUMAN_EXPERT_CONSTRAINTS],
    outputFormat: [
      'Respond ONLY with strict JSON: {"hooks": [{"style": string, "text": string}]} with exactly 5 entries, style being the pattern key used.',
    ],
  });

  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Topic: ${parsed.data.topic}` },
      ],
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    let hooks: { style: string; text: string }[] = [];
    try {
      const obj = (parseModelJsonObject(raw) ?? {}) as { hooks?: unknown };
      if (Array.isArray(obj.hooks)) {
        hooks = obj.hooks
          .map((h) => ({
            style: String(
              (h as Record<string, unknown>)?.style ?? "hook",
            ).trim(),
            text: String((h as Record<string, unknown>)?.text ?? "").trim(),
          }))
          .filter((h) => h.text)
          .slice(0, 6);
      }
    } catch {
      hooks = [];
    }
    res.json({ hooks });
  } catch (error) {
    req.log.error({ err: error }, "Hook generation failed");
    res.status(500).json({ error: "Failed to write hooks" });
  }
});

/** Per-platform norms baked into the platform-pack prompt. */
const PLATFORM_NORMS: Record<string, string> = {
  instagram:
    "Instagram: strong first line (it truncates early), short paragraphs with line breaks, 5-8 niche hashtags, a save/share-worthy close.",
  facebook:
    "Facebook: conversational and story-first, 1-3 hashtags at most, questions perform well, no hashtag walls.",
  linkedin:
    "LinkedIn: professional but human, a hook line then whitespace-heavy short paragraphs, max 3 hashtags, no emoji spam, end with a discussion question.",
  twitter:
    "X/Twitter: the ENTIRE caption must fit 280 characters including hashtags; punchy, max 2 hashtags, no filler.",
  threads:
    "Threads: casual and conversational, max ~500 characters, 0-2 hashtags, reads like a text to a friend.",
  youtube:
    "YouTube (community/description): searchable first sentence, then context; 3-5 hashtags at the end.",
};
const PLATFORM_PACK_DEFAULT = [
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
  "threads",
];

/**
 * POST /ai/platform-pack — one brief in, a tailored caption per platform out.
 * Funded exactly like one caption (quota first, then a caption credit): it
 * replaces writing the same brief five times.
 */
router.post("/ai/platform-pack", async (req: Request, res: Response) => {
  const parsed = GeneratePlatformPackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

  const platforms = (
    parsed.data.platforms && parsed.data.platforms.length > 0
      ? [...new Set(parsed.data.platforms)]
      : PLATFORM_PACK_DEFAULT
  ).filter((p) => p in PLATFORM_NORMS);

  const limits = await getPlanLimits(tenant.plan);
  const funding = await reserveFunding(
    req.tenantId,
    limits.captions,
    "caption",
  );
  if (!funding) {
    res.status(402).json({
      error: await outOfFundsMessage(
        req.tenantId,
        "caption",
        "Monthly caption quota reached and no caption credits left. Upgrade your plan or buy a credit pack.",
      ),
    });
    return;
  }

  const [brand, taste] = await Promise.all([
    loadBrandPayload(req.tenantId, parsed.data.brandKitId ?? null),
    buildTasteGuidance(req.tenantId),
  ]);
  const tone =
    parsed.data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");
  const context: string[] = [
    `Tone/voice: ${tone}.`,
    "Platform norms to follow exactly:",
    ...platforms.map((p) => PLATFORM_NORMS[p]!),
  ];
  const constraints = [...HUMAN_EXPERT_CONSTRAINTS];
  if (brand) {
    context.push(`Brand name: ${brand.identity.brand_name}.`);
    if (brand.voice.dos.length > 0)
      constraints.push(
        `Voice do's: ${brand.voice.dos.slice(0, 5).join("; ")}.`,
      );
    if (brand.voice.donts.length > 0)
      constraints.push(
        `Voice don'ts: ${brand.voice.donts.slice(0, 5).join("; ")}.`,
      );
    if (brand.brand_controls.restricted_terms.length > 0) {
      constraints.push(
        `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
      );
    }
  }

  const systemPrompt = buildRicePrompt({
    role: "You are a cross-platform social copywriter: the SAME idea, natively rewritten for each platform — never copy-pasted between them.",
    instruction: [
      `Write one caption for EACH of these platforms from the user's brief: ${platforms.join(", ")}.`,
      "Each caption must feel native to its platform (structure, length, tone) while carrying the same core idea and offer.",
      "Each caption ends with a clear call-to-action appropriate to that platform; also return that CTA separately.",
      "Also name the campaign idea in 3-8 words as `title`.",
    ],
    context,
    examples: taste.captionLines,
    constraints,
    outputFormat: [
      'Respond ONLY with strict JSON: {"title": string, "items": [{"platform": string, "caption": string, "hashtags": string[], "cta": string}]} — one item per requested platform, in the requested order.',
      "Hashtags must not include the # symbol.",
    ],
  });

  const startedAt = Date.now();
  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: parsed.data.brief },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    let title = "";
    let items: {
      platform: string;
      caption: string;
      hashtags: string[];
      cta: string;
    }[] = [];
    try {
      const obj = (parseModelJsonObject(raw) ?? {}) as {
        title?: unknown;
        items?: unknown;
      };
      title = typeof obj.title === "string" ? obj.title : "";
      if (Array.isArray(obj.items)) {
        items = obj.items
          .map((entry) => {
            const rec = (entry ?? {}) as Record<string, unknown>;
            return {
              platform: String(rec.platform ?? "")
                .toLowerCase()
                .trim(),
              caption: typeof rec.caption === "string" ? rec.caption : "",
              hashtags: Array.isArray(rec.hashtags)
                ? rec.hashtags
                    .map((h) => String(h).replace(/^#/, ""))
                    .filter(Boolean)
                : [],
              cta: typeof rec.cta === "string" ? rec.cta : "",
            };
          })
          .filter((item) => item.caption && platforms.includes(item.platform));
      }
    } catch {
      items = [];
    }
    if (items.length === 0) {
      await releaseFunding(req, funding, "caption");
      res.status(500).json({ error: "Failed to compile the platform pack" });
      return;
    }
    await settleFunding(req, funding, "caption", {
      requestBytes: Buffer.byteLength(systemPrompt + parsed.data.brief),
      responseBytes: Buffer.byteLength(raw),
      durationMs: Date.now() - startedAt,
      model: textGen.model,
      platform: "multi",
      ...(await buildTextCostMeta(completion, textGen)),
    });
    res.json({ ...(title ? { title } : {}), items });
  } catch (error) {
    await releaseFunding(req, funding, "caption");
    req.log.error({ err: error }, "Platform pack generation failed");
    res.status(500).json({ error: "Failed to compile the platform pack" });
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
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

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
      res.status(422).json({
        error: `Could not fetch the URL (status ${fetchRes.status}).`,
      });
      return;
    }
    const contentType = (
      fetchRes.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (
      contentType &&
      !ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t))
    ) {
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
    res.status(422).json({
      error: "Could not extract enough readable content from that URL.",
    });
    return;
  }

  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
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
      const parsedObj = parseModelJsonObject(raw);
      if (!parsedObj) {
        summary = raw;
      } else {
        const obj = parsedObj as { title?: unknown; summary?: unknown };
        title = typeof obj.title === "string" ? obj.title : "";
        summary = typeof obj.summary === "string" ? obj.summary : "";
      }
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

  const brand = await loadBrandPayload(
    req.tenantId,
    parsed.data.brandKitId ?? null,
  );

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
    guidance.push(
      `Bias suggested post angles toward this brand voice: ${voiceHint(brand)}.`,
    );
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
            if (
              parsedUrl.protocol !== "http:" &&
              parsedUrl.protocol !== "https:"
            )
              continue;
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
      // The model may wrap JSON in prose or fences; use the shared tolerant
      // parser. Null keeps the raw-text fallback in the catch below.
      const parsedObj = parseModelJsonObject(raw);
      if (!parsedObj) throw new Error("unparseable research output");
      const obj = parsedObj as {
        summary?: unknown;
        keyFindings?: unknown;
        suggestedAngles?: unknown;
      };
      summary = typeof obj.summary === "string" ? obj.summary : "";
      keyFindings = Array.isArray(obj.keyFindings)
        ? obj.keyFindings
            .map((f) => String(f).trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
      suggestedAngles = Array.isArray(obj.suggestedAngles)
        ? obj.suggestedAngles
            .map((a) => String(a).trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];
    } catch {
      summary = raw.trim();
    }

    if (!summary) {
      res.status(422).json({
        error:
          "Research produced no usable results. Try a more specific topic.",
      });
      return;
    }

    res.json({
      summary,
      keyFindings,
      sources: sources.slice(0, 8),
      suggestedAngles,
    });
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
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

  const platforms = Array.from(
    new Set(
      parsed.data.platforms.map((p) => p.toLowerCase().trim()).filter(Boolean),
    ),
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
  // Wallet workspaces pay per campaign from the rupee balance: one
  // all-or-nothing debit covering every platform, settled to the real
  // provider cost once the model reports back. Quota workspaces keep the
  // original split — as much as the plan allows, the rest from credits.
  const campaignOnWallet = await isWalletFunded(req.tenantId);
  const campaignWallet = campaignOnWallet
    ? await reserveWallet(
        req.tenantId,
        "caption",
        { model: textGen.model, provider: textGen.provider },
        platforms.length,
      )
    : null;
  let quotaFunded = platforms.length;
  let creditFunded = 0;
  if (campaignOnWallet) {
    quotaFunded = 0;
    if (!campaignWallet) {
      res.status(402).json({
        error:
          "Your wallet balance can't cover this campaign. Recharge to continue, or pick fewer platforms.",
      });
      return;
    }
  } else if (limits.captions !== -1) {
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

  /**
   * Give back whatever was reserved for this campaign, on either rail.
   * Once-only, and refuses after the charge has settled: a throw AFTER a
   * successful settle must not refund the reservation on top of it.
   */
  let campaignFundingResolved = false;
  const refundCampaignFunding = async (reason: string) => {
    if (campaignFundingResolved) return;
    campaignFundingResolved = true;
    try {
      if (campaignWallet) {
        await refundWallet(req.tenantId, campaignWallet, reason);
      } else if (creditFunded > 0) {
        await refundCredits(req.tenantId, "caption", creditFunded, reason);
      }
    } catch (refundError) {
      req.log.error(
        { err: refundError },
        "Failed to refund reserved campaign funding",
      );
    }
  };

  const brand = await loadBrandPayload(
    req.tenantId,
    parsed.data.brandKitId ?? null,
  );
  const tone =
    parsed.data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");

  // Draft for the roomiest platform FIRST, then condense down: the master
  // long-form draft carries the full argument, and constrained platforms get
  // distilled versions of it rather than independently thin rewrites.
  const rankedPlatforms = [...platforms].sort(
    (a, b) => (PLATFORM_CAPACITY[b] ?? 1000) - (PLATFORM_CAPACITY[a] ?? 1000),
  );
  const masterPlatform = rankedPlatforms[0];

  const styleLines = platforms.map(
    (p) =>
      `${p}: caption style -> ${PLATFORM_STYLES[p] ?? p}; image style -> ${PLATFORM_IMAGE_STYLES[p] ?? "high quality, on-brand"}.`,
  );
  const capacityLines = rankedPlatforms.map(
    (p) => `${p}: about ${PLATFORM_CAPACITY[p] ?? 1000} characters available.`,
  );

  const context: string[] = [
    `Requested platforms, ordered from most to least character room: ${rankedPlatforms.join(", ")}.`,
    ...capacityLines,
    `Overall tone/voice: ${tone}.`,
    ...styleLines,
  ];
  const constraints: string[] = [...HUMAN_EXPERT_CONSTRAINTS];
  if (brand) {
    context.push(`Brand name: ${brand.identity.brand_name}.`);
    const palette = colorHint(brand);
    if (palette) {
      context.push(
        `Incorporate the brand palette (${palette}) into each image prompt.`,
      );
    }
    if (brand.brand_controls.restricted_terms.length > 0) {
      constraints.push(
        `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
      );
    }
  }

  const campaignOutputFormat = [
    'Respond ONLY with strict JSON of the form {"title": string, "posts": [{"platform": string, "caption": string, "hashtags": string[], "imagePrompt": string}]}.',
    "Include one object per requested platform, using the exact platform identifiers given. Hashtags must not include the # symbol; provide 5-12 per post.",
    'If (and only if) the brief is too thin, respond instead with {"clarifyingQuestions": string[]}.',
  ];

  // Prompt Template Kit: a production campaign template replaces the built-in
  // RICE prompt; the JSON contract and platform context are appended so the
  // response stays parseable. Fail-open: null keeps the prompt below.
  const governed = await getGovernedPrompt({
    flowKey: "campaign",
    tenantId: req.tenantId,
    clerkUserId: req.clerkUserId,
    runtimeContext: [...context, ...constraints].join("\n"),
    outputFormat: [CLARIFY_RULE, ...campaignOutputFormat].join("\n"),
    placeholderValues: { platforms: rankedPlatforms.join(", "), tone },
  });

  const systemPrompt =
    governed?.text ??
    buildRicePrompt({
      role: "You are a senior social media strategist and expert copywriter with deep, hands-on experience running multi-platform campaigns in this niche.",
      instruction: [
        CLARIFY_RULE,
        `Otherwise: FIRST write the full master caption for ${masterPlatform} — the platform with the most character room — developing the idea completely.`,
        "THEN adapt that master caption down for each remaining platform in decreasing order of character room: condense and reshape it to fit each platform's limit and format while keeping the core message, strongest hook, and expert specifics. Do not write unrelated captions per platform.",
        "For each platform also write a concise, descriptive AI image-generation prompt that complements its caption.",
        "Also produce a short creative-brief title (3-8 words) naming the campaign idea.",
      ],
      context,
      examples: [],
      constraints,
      outputFormat: campaignOutputFormat,
    });

  const campaignId = randomUUID();
  const startedAt = Date.now();
  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: parsed.data.prompt },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let postsRaw: unknown[] = [];
    let title = "";
    let clarifyingQuestions: string[] | null = null;
    try {
      const obj = (parseModelJsonObject(raw) ?? {}) as {
        posts?: unknown;
        title?: string;
      };
      clarifyingQuestions = parseClarifyingQuestions(obj);
      postsRaw = Array.isArray(obj.posts) ? obj.posts : [];
      title = typeof obj.title === "string" ? obj.title : "";
    } catch {
      postsRaw = [];
    }

    // The model asked for more input instead of generating: give back any
    // reserved credits (nothing was made) and return the questions.
    if (clarifyingQuestions && postsRaw.length === 0) {
      await refundCampaignFunding("campaign needs more input");
      res.json({ posts: [], clarifyingQuestions });
      return;
    }

    const byPlatform = new Map<
      string,
      { caption: string; hashtags: string[]; imagePrompt: string }
    >();
    for (const item of postsRaw) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const platform = String(o.platform ?? "")
        .toLowerCase()
        .trim();
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

    // Unusable output (malformed JSON, no posts, or posts without any caption
    // text): charge nothing — release the reservation and report the failure,
    // mirroring the carousel's incomplete-output branch.
    if (posts.every((p) => !p.caption)) {
      await refundCampaignFunding(
        "campaign generation returned no usable posts",
      );
      if (governed) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "campaign",
          governed,
          generationContext: { platforms, model: textGen.model, campaignId },
          success: false,
          latencyMs: Date.now() - startedAt,
        });
      }
      req.log.error(
        { campaignId },
        "Campaign generation returned no usable posts",
      );
      res.status(500).json({ error: "Failed to generate campaign" });
      return;
    }

    // One usage row per platform, tagged with the campaign id so data
    // consumption can be reported per campaign. Credit-funded captions were
    // already debited at reservation time; funding="credit" rows are excluded
    // from quota counting but still metered.
    const requestBytes = Buffer.byteLength(systemPrompt + parsed.data.prompt);
    const perPlatformRequest = Math.ceil(requestBytes / platforms.length);
    // One completion produced all platforms: split its tokens/cost across
    // the per-platform rows (remainder lands on the first row) so the sum
    // over rows equals the real total.
    const costMeta = await buildTextCostMeta(completion, textGen);
    const splitAcross = (
      total: number | undefined,
      i: number,
    ): number | undefined => {
      if (total === undefined) return undefined;
      const base = Math.floor(total / posts.length);
      return i === 0 ? total - base * (posts.length - 1) : base;
    };
    // Keep each row's snapshotted display amount: their sum is the REAL
    // campaign spend handed back to the client as `spendPaise`.
    const spendRows = await Promise.all(
      posts.map((post, i) =>
        recordUsage(req.tenantId, "caption", {
          funding: campaignWallet
            ? "wallet"
            : i < quotaFunded
              ? "quota"
              : "credit",
          requestBytes: perPlatformRequest,
          responseBytes: Buffer.byteLength(JSON.stringify(post)),
          durationMs: Date.now() - startedAt,
          model: textGen.model,
          campaignId,
          platform: post.platform,
          provider: costMeta.provider,
          inputTokens: splitAcross(costMeta.inputTokens ?? undefined, i),
          outputTokens: splitAcross(costMeta.outputTokens ?? undefined, i),
          costPaise: splitAcross(costMeta.costPaise ?? undefined, i),
        }),
      ),
    );
    // A partial sum would silently understate the spend, so any row without a
    // snapshot makes the whole figure null (client falls back to flat rates).
    const campaignSpendPaise = spendRows.every((row) => row != null)
      ? spendRows.reduce((sum: number, row) => sum + (row ?? 0), 0)
      : null;
    // Wallet: true the up-front estimate up to the real cost of the one
    // completion that produced every platform, plus the platform fee. Marked
    // resolved first so nothing downstream can refund a settled charge.
    campaignFundingResolved = true;
    if (campaignWallet) {
      try {
        await settleWallet(req.tenantId, campaignWallet, {
          kind: "caption",
          costPaise: costMeta.costPaise ?? null,
          provider: costMeta.provider ?? null,
          model: textGen.model,
          inputTokens: costMeta.inputTokens ?? null,
          outputTokens: costMeta.outputTokens ?? null,
          refKind: "campaign",
          refId: campaignId,
        });
      } catch (settleError) {
        req.log.error(
          { err: settleError },
          "Failed to settle campaign wallet charge",
        );
      }
    }
    if (governed) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "campaign",
        governed,
        generationContext: { platforms, model: textGen.model, campaignId },
        success: true,
        latencyMs: Date.now() - startedAt,
        tokenUsage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens ?? 0,
              completionTokens: completion.usage.completion_tokens ?? 0,
              totalTokens: completion.usage.total_tokens ?? 0,
            }
          : null,
      });
    }
    res.json({
      posts,
      campaignId,
      ...(title ? { title } : {}),
      ...(campaignSpendPaise != null ? { spendPaise: campaignSpendPaise } : {}),
    });
  } catch (error) {
    await refundCampaignFunding("campaign generation failed");
    if (governed) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "campaign",
        governed,
        generationContext: { platforms, model: textGen.model, campaignId },
        success: false,
        latencyMs: Date.now() - startedAt,
      });
    }
    req.log.error({ err: error }, "Campaign generation failed");
    res.status(500).json({ error: "Failed to generate campaign" });
  }
});

/**
 * Decode a JSON string literal starting at `start` (the index of the first
 * character AFTER the opening quote) in a partially received document.
 * Returns the text decoded so far and whether the closing quote was seen.
 */
function decodePartialJsonString(
  raw: string,
  start: number,
): { text: string; done: boolean } {
  let out = "";
  let i = start;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break; // escape split across chunks; wait
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) out += String.fromCharCode(code);
        i += 6;
        continue;
      } else out += next;
      i += 2;
      continue;
    }
    if (ch === '"') return { text: out, done: true };
    out += ch;
    i += 1;
  }
  return { text: out, done: false };
}

/**
 * Incrementally extract per-platform caption text from a partially received
 * campaign JSON document of the form
 * {"title": ..., "posts": [{"platform": "x", "caption": "...", ...}, ...]}.
 * The campaign prompt asks for "platform" before "caption" inside each post,
 * so each caption is attributed to the closest preceding platform key. The
 * terminal result event always comes from a full JSON.parse, so any
 * attribution slip during streaming is cosmetic and self-corrects.
 */
export function extractPartialCampaign(
  raw: string,
): Array<{ platform: string; text: string; done: boolean }> {
  const out: Array<{ platform: string; text: string; done: boolean }> = [];
  const platformRe = /"platform"\s*:\s*"([^"]*)"/g;
  const marks: Array<{ platform: string; end: number }> = [];
  for (let m = platformRe.exec(raw); m; m = platformRe.exec(raw)) {
    marks.push({
      platform: m[1]!.toLowerCase().trim(),
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const regionEnd = i + 1 < marks.length ? marks[i + 1]!.end : raw.length;
    const region = raw.slice(mark.end, regionEnd);
    const capMatch = /"caption"\s*:\s*"/.exec(region);
    if (!capMatch) {
      out.push({ platform: mark.platform, text: "", done: false });
      continue;
    }
    const decoded = decodePartialJsonString(
      raw,
      mark.end + capMatch.index + capMatch[0].length,
    );
    out.push({
      platform: mark.platform,
      text: decoded.text,
      done: decoded.done,
    });
  }
  return out;
}

/**
 * POST /ai/generate-campaign/stream — the SSE variant of campaign generation.
 *
 * Contract: funding is identical to the JSON route (plan quota first, then an
 * atomic all-or-nothing credit reservation, 402 when the two together cannot
 * cover one caption per platform). Events are SSE `data:` lines of JSON:
 *   {type:"delta", platform, text} — newly available caption text for a platform
 *   {type:"result", posts, campaignId, title?} — final full campaign
 *   {type:"result", posts: [], clarifyingQuestions} — model needs more input
 *   {type:"error", message} — terminal failure
 * On success one usage row is recorded per platform (campaign-tagged). If the
 * client disconnects mid-stream after any caption text was delivered, the
 * campaign SETTLES (usage rows are still recorded — otherwise clients could
 * read the captions and drop the connection to dodge the charge); reserved
 * credits are refunded only when nothing usable was sent. Gated by the
 * campaignStreaming kill switch; the JSON route stays unchanged.
 */
router.post(
  "/ai/generate-campaign/stream",
  requireFeature("campaignStreaming"),
  async (req: Request, res: Response) => {
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
    const textGen = await getTextGenOrRespond(res, tenant.aiModel);
    if (!textGen) return;

    const platforms = Array.from(
      new Set(
        parsed.data.platforms
          .map((p) => p.toLowerCase().trim())
          .filter(Boolean),
      ),
    );
    if (platforms.length === 0) {
      res.status(400).json({ error: "Select at least one platform." });
      return;
    }

    const limits = await getPlanLimits(tenant.plan);
    const usage = await getUsage(req.tenantId);
    // Wallet workspaces pay per campaign from the rupee balance: one
    // all-or-nothing debit covering every platform, settled to the real
    // provider cost once the model reports back. Quota workspaces keep the
    // original split — as much as the plan allows, the rest from credits.
    const campaignOnWallet = await isWalletFunded(req.tenantId);
    const campaignWallet = campaignOnWallet
      ? await reserveWallet(
          req.tenantId,
          "caption",
          { model: textGen.model, provider: textGen.provider },
          platforms.length,
        )
      : null;
    let quotaFunded = platforms.length;
    let creditFunded = 0;
    if (campaignOnWallet) {
      quotaFunded = 0;
      if (!campaignWallet) {
        res.status(402).json({
          error:
            "Your wallet balance can't cover this campaign. Recharge to continue, or pick fewer platforms.",
        });
        return;
      }
    } else if (limits.captions !== -1) {
      const remainingQuota = Math.max(0, limits.captions - usage.captions);
      quotaFunded = Math.min(platforms.length, remainingQuota);
      creditFunded = platforms.length - quotaFunded;
      if (creditFunded > 0) {
        const reserved = await spendCredit(
          req.tenantId,
          "caption",
          creditFunded,
        );
        if (!reserved) {
          res.status(402).json({
            error:
              "This campaign would exceed your monthly caption quota and you don't have enough caption credits. Upgrade your plan, buy a credit pack, or pick fewer platforms.",
          });
          return;
        }
      }
    }

    /**
     * Give back whatever was reserved for this campaign, on either rail.
     * Once-only, and refuses after the charge has settled: a throw AFTER a
     * successful settle must not refund the reservation on top of it.
     */
    let campaignFundingResolved = false;
    const refundCampaignFunding = async (reason: string) => {
      if (campaignFundingResolved) return;
      campaignFundingResolved = true;
      try {
        if (campaignWallet) {
          await refundWallet(req.tenantId, campaignWallet, reason);
        } else if (creditFunded > 0) {
          await refundCredits(req.tenantId, "caption", creditFunded, reason);
        }
      } catch (refundError) {
        req.log.error(
          { err: refundError },
          "Failed to refund reserved campaign funding",
        );
      }
    };

    const brand = await loadBrandPayload(
      req.tenantId,
      parsed.data.brandKitId ?? null,
    );
    const tone =
      parsed.data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");
    const rankedPlatforms = [...platforms].sort(
      (a, b) => (PLATFORM_CAPACITY[b] ?? 1000) - (PLATFORM_CAPACITY[a] ?? 1000),
    );
    const masterPlatform = rankedPlatforms[0];
    const styleLines = platforms.map(
      (p) =>
        `${p}: caption style -> ${PLATFORM_STYLES[p] ?? p}; image style -> ${PLATFORM_IMAGE_STYLES[p] ?? "high quality, on-brand"}.`,
    );
    const capacityLines = rankedPlatforms.map(
      (p) =>
        `${p}: about ${PLATFORM_CAPACITY[p] ?? 1000} characters available.`,
    );
    const context: string[] = [
      `Requested platforms, ordered from most to least character room: ${rankedPlatforms.join(", ")}.`,
      ...capacityLines,
      `Overall tone/voice: ${tone}.`,
      ...styleLines,
    ];
    const constraints: string[] = [...HUMAN_EXPERT_CONSTRAINTS];
    if (brand) {
      context.push(`Brand name: ${brand.identity.brand_name}.`);
      const palette = colorHint(brand);
      if (palette) {
        context.push(
          `Incorporate the brand palette (${palette}) into each image prompt.`,
        );
      }
      if (brand.brand_controls.restricted_terms.length > 0) {
        constraints.push(
          `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
        );
      }
    }
    const streamOutputFormat = [
      'Respond ONLY with strict JSON of the form {"title": string, "posts": [{"platform": string, "caption": string, "hashtags": string[], "imagePrompt": string}]}. Inside each post object, always emit the "platform" field first, then "caption".',
      "Include one object per requested platform, using the exact platform identifiers given. Hashtags must not include the # symbol; provide 5-12 per post.",
      'If (and only if) the brief is too thin, respond instead with {"clarifyingQuestions": string[]}.',
    ];

    // Prompt Template Kit: same replacement as the JSON campaign route. The
    // output contract (including platform-before-caption ordering, which the
    // streaming parser depends on) is always appended, so streamed partial
    // attribution keeps working under a governed prompt.
    const governed = await getGovernedPrompt({
      flowKey: "campaign",
      tenantId: req.tenantId,
      clerkUserId: req.clerkUserId,
      runtimeContext: [...context, ...constraints].join("\n"),
      outputFormat: [CLARIFY_RULE, ...streamOutputFormat].join("\n"),
      placeholderValues: { platforms: rankedPlatforms.join(", "), tone },
    });

    const systemPrompt =
      governed?.text ??
      buildRicePrompt({
        role: "You are a senior social media strategist and expert copywriter with deep, hands-on experience running multi-platform campaigns in this niche.",
        instruction: [
          CLARIFY_RULE,
          `Otherwise: FIRST write the full master caption for ${masterPlatform} — the platform with the most character room — developing the idea completely.`,
          "THEN adapt that master caption down for each remaining platform in decreasing order of character room: condense and reshape it to fit each platform's limit and format while keeping the core message, strongest hook, and expert specifics. Do not write unrelated captions per platform.",
          "For each platform also write a concise, descriptive AI image-generation prompt that complements its caption.",
          "Also produce a short creative-brief title (3-8 words) naming the campaign idea.",
        ],
        context,
        examples: [],
        constraints,
        outputFormat: streamOutputFormat,
      });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const campaignId = randomUUID();
    const startedAt = Date.now();
    let raw = "";
    let sentTotal = 0;
    /** Measured on the first content delta; null if none ever arrived. */
    let ttftMs: number | null = null;
    // Exactly one funding settlement per request (settle = usage rows are
    // recorded; refund = reserved credits go back), no matter how the stream
    // ends (result, clarify, error, or the client going away mid-stream).
    let fundingResolved = false;
    const refundOnce = async (reason: string) => {
      if (fundingResolved) return;
      fundingResolved = true;
      await refundCampaignFunding(reason);
    };
    /**
     * Record the per-platform usage rows (no funding-state guard). Returns
     * the summed snapshotted display amount (paise) across the rows — the
     * REAL campaign spend for the result event — or null when any row failed
     * to snapshot (a partial sum would silently understate the spend).
     */
    const settleRows = async (
      posts: Array<{
        platform: string;
        caption: string;
        hashtags: string[];
        imagePrompt: string;
      }>,
      costMeta: Awaited<ReturnType<typeof buildTextCostMeta>>,
    ): Promise<number | null> => {
      const requestBytes = Buffer.byteLength(systemPrompt + parsed.data.prompt);
      const perPlatformRequest = Math.ceil(requestBytes / posts.length);
      const splitAcross = (
        total: number | undefined,
        i: number,
      ): number | undefined => {
        if (total === undefined) return undefined;
        const base = Math.floor(total / posts.length);
        return i === 0 ? total - base * (posts.length - 1) : base;
      };
      let spendPaise: number | null = null;
      try {
        const spendRows = await Promise.all(
          posts.map((post, i) =>
            recordUsage(req.tenantId, "caption", {
              funding: campaignWallet
                ? "wallet"
                : i < quotaFunded
                  ? "quota"
                  : "credit",
              requestBytes: perPlatformRequest,
              responseBytes: Buffer.byteLength(JSON.stringify(post)),
              durationMs: Date.now() - startedAt,
              model: textGen.model,
              campaignId,
              platform: post.platform,
              provider: costMeta.provider,
              inputTokens: splitAcross(costMeta.inputTokens ?? undefined, i),
              outputTokens: splitAcross(costMeta.outputTokens ?? undefined, i),
              costPaise: splitAcross(costMeta.costPaise ?? undefined, i),
              // Subsets of the token counts, so they are apportioned the same
              // way. TTFT is not: it is one measured latency the whole
              // campaign shared, and dividing it would be meaningless.
              cachedInputTokens: splitAcross(
                costMeta.cachedInputTokens ?? undefined,
                i,
              ),
              reasoningTokens: splitAcross(
                costMeta.reasoningTokens ?? undefined,
                i,
              ),
              ...(ttftMs === null ? {} : { ttftMs }),
            }),
          ),
        );
        spendPaise = spendRows.every((row) => row != null)
          ? spendRows.reduce((sum: number, row) => sum + (row ?? 0), 0)
          : null;
      } catch (usageError) {
        req.log.error(
          { err: usageError },
          "Failed to record streamed campaign usage",
        );
      }
      // Wallet: true the up-front estimate up to the real cost of the one
      // completion that produced every platform, plus the platform fee. Marked
      // resolved first so nothing downstream can refund a settled charge.
      campaignFundingResolved = true;
      if (campaignWallet) {
        try {
          await settleWallet(req.tenantId, campaignWallet, {
            kind: "caption",
            costPaise: costMeta.costPaise ?? null,
            provider: costMeta.provider ?? null,
            model: textGen.model,
            inputTokens: costMeta.inputTokens ?? null,
            outputTokens: costMeta.outputTokens ?? null,
            refKind: "campaign",
            refId: campaignId,
          });
        } catch (settleError) {
          req.log.error(
            { err: settleError },
            "Failed to settle campaign wallet charge",
          );
        }
      }
      return spendPaise;
    };
    /** Build the per-platform post list from whatever JSON arrived so far. */
    const buildPosts = (
      postsRaw: unknown[],
    ): Array<{
      platform: string;
      caption: string;
      hashtags: string[];
      imagePrompt: string;
    }> => {
      const byPlatform = new Map<
        string,
        { caption: string; hashtags: string[]; imagePrompt: string }
      >();
      for (const item of postsRaw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const platform = String(o.platform ?? "")
          .toLowerCase()
          .trim();
        if (!platform) continue;
        byPlatform.set(platform, {
          caption: typeof o.caption === "string" ? o.caption : "",
          hashtags: Array.isArray(o.hashtags)
            ? o.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
            : [],
          imagePrompt: typeof o.imagePrompt === "string" ? o.imagePrompt : "",
        });
      }
      return platforms.map((platform) => {
        const found = byPlatform.get(platform);
        return {
          platform,
          caption: found?.caption ?? "",
          hashtags: found?.hashtags ?? [],
          imagePrompt: found?.imagePrompt ?? "",
        };
      });
    };

    const abort = new AbortController();
    let lastUsage: CompletionUsageLike = {};
    res.on("close", () => {
      if (!res.writableEnded) {
        // Client disconnected mid-stream: stop paying the model. If caption
        // text was already delivered via deltas, the generation was consumed —
        // settle with whatever arrived (partial captions still charge; the
        // model run cost the same). Only refund when nothing usable was sent.
        abort.abort();
        if (sentTotal > 0 && !fundingResolved) {
          // Claim the settlement synchronously so the abort error surfacing
          // in the main try/catch cannot refund the funding first.
          fundingResolved = true;
          void (async () => {
            const partial = extractPartialCampaign(raw);
            const posts = buildPosts(
              partial.map((p) => ({ platform: p.platform, caption: p.text })),
            );
            const costMeta = await buildTextCostMeta(lastUsage, textGen);
            await settleRows(posts, costMeta);
          })();
        } else {
          void refundOnce("campaign stream disconnected before delivery");
        }
      }
    });

    try {
      const stream = await textGen.client.chat.completions.create(
        {
          model: textGen.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: parsed.data.prompt },
          ],
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          stream: true,
          ...usageAccountingParams(textGen.provider),
          ...streamUsageParams(),
        },
        { signal: abort.signal },
      );

      // Track how much of each platform's caption has been sent so deltas
      // carry only new text.
      const sentByPlatform = new Map<string, number>();
      for await (const chunk of stream) {
        if (chunk.usage) lastUsage = { usage: chunk.usage };
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (!delta) continue;
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        raw += delta;
        for (const p of extractPartialCampaign(raw)) {
          const sent = sentByPlatform.get(p.platform) ?? 0;
          if (p.text.length > sent) {
            send({
              type: "delta",
              platform: p.platform,
              text: p.text.slice(sent),
            });
            sentByPlatform.set(p.platform, p.text.length);
            sentTotal += p.text.length - sent;
          }
        }
      }

      let postsRaw: unknown[] = [];
      let title = "";
      let clarifyingQuestions: string[] | null = null;
      try {
        const obj = (parseModelJsonObject(raw) ?? {}) as {
          posts?: unknown;
          title?: string;
        };
        clarifyingQuestions = parseClarifyingQuestions(obj);
        postsRaw = Array.isArray(obj.posts) ? obj.posts : [];
        title = typeof obj.title === "string" ? obj.title : "";
      } catch {
        postsRaw = [];
      }

      if (clarifyingQuestions && postsRaw.length === 0) {
        await refundOnce("campaign needs more input");
        send({ type: "result", posts: [], clarifyingQuestions });
        res.end();
        return;
      }

      const posts = buildPosts(postsRaw);

      // Unusable output (malformed JSON, no posts, or posts without any
      // caption text): charge nothing. No caption text means no deltas were
      // ever sent, so nothing usable reached the client.
      if (posts.every((p) => !p.caption)) {
        await refundOnce("campaign generation returned no usable posts");
        if (governed) {
          await logCompiledPrompt({
            tenantId: req.tenantId,
            clerkUserId: req.clerkUserId,
            flowKey: "campaign",
            governed,
            generationContext: {
              platforms,
              model: textGen.model,
              campaignId,
              streamed: true,
            },
            success: false,
            latencyMs: Date.now() - startedAt,
          });
        }
        req.log.error(
          { campaignId },
          "Streaming campaign generation returned no usable posts",
        );
        send({ type: "error", message: "Failed to generate campaign" });
        res.end();
        return;
      }

      const costMeta = await buildTextCostMeta(
        lastUsage.usage ? lastUsage : {},
        textGen,
      );
      let streamSpendPaise: number | null = null;
      if (!fundingResolved) {
        fundingResolved = true;
        streamSpendPaise = await settleRows(posts, costMeta);
      }
      if (governed) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "campaign",
          governed,
          generationContext: {
            platforms,
            model: textGen.model,
            campaignId,
            streamed: true,
          },
          success: true,
          latencyMs: Date.now() - startedAt,
          tokenUsage: lastUsage.usage
            ? {
                promptTokens: lastUsage.usage.prompt_tokens ?? 0,
                completionTokens: lastUsage.usage.completion_tokens ?? 0,
                // Streamed usage payloads don't include total_tokens; derive it.
                totalTokens:
                  (lastUsage.usage.prompt_tokens ?? 0) +
                  (lastUsage.usage.completion_tokens ?? 0),
              }
            : null,
        });
      }
      send({
        type: "result",
        posts,
        campaignId,
        ...(title ? { title } : {}),
        ...(streamSpendPaise != null ? { spendPaise: streamSpendPaise } : {}),
      });
      res.end();
    } catch (error) {
      await refundOnce("campaign generation failed");
      if (governed && !abort.signal.aborted) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "campaign",
          governed,
          generationContext: {
            platforms,
            model: textGen.model,
            campaignId,
            streamed: true,
          },
          success: false,
          latencyMs: Date.now() - startedAt,
        });
      }
      if (!abort.signal.aborted) {
        req.log.error({ err: error }, "Streaming campaign generation failed");
      }
      send({ type: "error", message: "Failed to generate campaign" });
      res.end();
    }
  },
);

/**
 * POST /ai/generate-carousel
 * One brief -> a multi-slide carousel: per-slide heading/body copy plus an
 * image prompt for each slide. Costs ONE caption (quota first, then a
 * credit); the per-slide images are generated afterwards by the client via
 * /ai/generate-image (metered per image as usual). Gated by the "carousel"
 * kill switch at the router level.
 */
router.post("/ai/generate-carousel", async (req: Request, res: Response) => {
  const parsed = GenerateCarouselBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const textGen = await getTextGenOrRespond(res, tenant.aiModel);
  if (!textGen) return;

  const slideCount = parsed.data.slideCount ?? 5;
  const platform =
    (parsed.data.platform ?? "linkedin").toLowerCase().trim() || "linkedin";

  const limits = await getPlanLimits(tenant.plan);
  const captionFunding = await reserveFunding(
    req.tenantId,
    limits.captions,
    "caption",
  );
  if (!captionFunding) {
    res.status(402).json({
      error: await outOfFundsMessage(
        req.tenantId,
        "caption",
        "You've used your monthly caption quota and have no caption credits left. Upgrade your plan or buy a credit pack to keep generating.",
      ),
    });
    return;
  }

  const brand = await loadBrandPayload(
    req.tenantId,
    parsed.data.brandKitId ?? null,
  );
  const tone =
    parsed.data.tone ?? (brand ? voiceHint(brand) : "friendly and engaging");

  const context: string[] = [
    `The carousel has exactly ${slideCount} slides and is primarily for ${platform}.`,
    `Overall tone/voice: ${tone}.`,
    "Slide 1 is the hook: a bold, curiosity-driving opener. The middle slides each carry ONE clear idea that builds on the previous slide. The final slide is the payoff plus a call to action.",
    "Each slide's image prompt must describe a graphic that VISUALLY COMMUNICATES that slide's specific information (e.g. the key statistic, step, or comparison rendered as part of the image), not a generic decorative background. Include the slide's short headline text inside the image design.",
    "Keep a consistent visual system across all slide image prompts: same color scheme, same layout style, same typography treatment, so the slides read as one cohesive carousel.",
  ];
  const constraints: string[] = [...HUMAN_EXPERT_CONSTRAINTS];
  if (brand) {
    context.push(`Brand name: ${brand.identity.brand_name}.`);
    const palette = colorHint(brand);
    if (palette) {
      context.push(
        `Use the brand palette (${palette}) as the carousel's color scheme in every image prompt.`,
      );
    }
    if (brand.brand_controls.restricted_terms.length > 0) {
      constraints.push(
        `Never use these restricted terms: ${brand.brand_controls.restricted_terms.join(", ")}.`,
      );
    }
  }

  const carouselOutputFormat = [
    `Respond ONLY with strict JSON of the form {"title": string, "caption": string, "hashtags": string[], "slides": [{"heading": string, "body": string, "imagePrompt": string}]} with exactly ${slideCount} slide objects in order.`,
    'If (and only if) the brief is too thin, respond instead with {"clarifyingQuestions": string[]}.',
  ];

  // Prompt Template Kit: an admin-published production template for the
  // carousel flow replaces the built-in RICE prompt (runtime context and the
  // JSON output contract are appended so parsing never breaks). Fail-open:
  // null keeps the built-in prompt below exactly as before.
  let governed = null as Awaited<ReturnType<typeof getGovernedPrompt>>;
  if (req.clerkUserId) {
    governed = await getGovernedPrompt({
      flowKey: "carousel",
      tenantId: req.tenantId,
      clerkUserId: req.clerkUserId,
      runtimeContext: [...context, ...constraints].join("\n"),
      outputFormat: [CLARIFY_RULE, ...carouselOutputFormat].join("\n"),
      placeholderValues: { platform, tone, slideCount: String(slideCount) },
    });
  }

  const systemPrompt = governed
    ? governed.text
    : buildRicePrompt({
        role: "You are a senior social media strategist and carousel designer with deep experience creating high-performing multi-slide posts in this niche.",
        instruction: [
          CLARIFY_RULE,
          `Otherwise: design a ${slideCount}-slide carousel that develops the idea across the slides in a deliberate narrative arc.`,
          "For every slide write a short punchy heading (max ~8 words), 1-3 sentences of body copy, and a concise, descriptive AI image-generation prompt for that slide's visual.",
          "Also write the post caption that will accompany the carousel, 5-12 hashtags (no # symbol), and a short creative-brief title (3-8 words).",
        ],
        context,
        examples: [],
        constraints,
        outputFormat: carouselOutputFormat,
      });

  const carouselId = randomUUID();
  const startedAt = Date.now();
  try {
    // One automatic retry: an incomplete/malformed carousel is usually a
    // one-off model flake, so a second attempt rescues the request instead
    // of surfacing a bare 500 to the user.
    let completion!: Awaited<
      ReturnType<typeof textGen.client.chat.completions.create>
    > & {
      choices: Array<{ message?: { content?: string | null } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    let raw = "{}";
    let slidesRaw: unknown[] = [];
    let title = "";
    let caption = "";
    let hashtags: string[] = [];
    let clarifyingQuestions: string[] | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      completion = (await textGen.client.chat.completions.create({
        model: textGen.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: parsed.data.prompt },
        ],
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        ...usageAccountingParams(textGen.provider),
      })) as typeof completion;

      raw = completion.choices[0]?.message?.content ?? "{}";
      slidesRaw = [];
      title = "";
      caption = "";
      hashtags = [];
      clarifyingQuestions = null;
      try {
        const obj = (parseModelJsonObject(raw) ?? {}) as {
          slides?: unknown;
          title?: string;
          caption?: string;
          hashtags?: unknown;
        };
        clarifyingQuestions = parseClarifyingQuestions(obj);
        slidesRaw = Array.isArray(obj.slides) ? obj.slides : [];
        title = typeof obj.title === "string" ? obj.title : "";
        caption = typeof obj.caption === "string" ? obj.caption : "";
        hashtags = Array.isArray(obj.hashtags)
          ? obj.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
          : [];
      } catch {
        slidesRaw = [];
      }
      // Mirror the final validation exactly (object-shaped AND has a real
      // heading or body) so any carousel that would fail below gets its retry.
      const usableSlides = slidesRaw
        .filter(
          (s): s is Record<string, unknown> => !!s && typeof s === "object",
        )
        .filter(
          (s) =>
            (typeof s.heading === "string" && s.heading) ||
            (typeof s.body === "string" && s.body),
        ).length;
      if (clarifyingQuestions || usableSlides >= slideCount) break;
      req.log.warn(
        {
          attempt,
          model: textGen.model,
          governed: !!governed,
          slideCount,
          parsedSlides: usableSlides,
          rawLength: raw.length,
          parsedTopLevelKeys: Object.keys(parseModelJsonObject(raw) ?? {}),
        },
        "Carousel generation returned an incomplete carousel",
      );
    }

    // The model asked for more input instead of generating: give back the
    // reserved credit (nothing was made) and return the questions.
    if (clarifyingQuestions && slidesRaw.length === 0) {
      await releaseFunding(req, captionFunding, "caption");
      res.json({ slides: [], clarifyingQuestions });
      return;
    }

    const slides = slidesRaw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        heading: typeof s.heading === "string" ? s.heading : "",
        body: typeof s.body === "string" ? s.body : "",
        imagePrompt: typeof s.imagePrompt === "string" ? s.imagePrompt : "",
        imagePath: null as string | null,
      }))
      .filter((s) => s.heading || s.body)
      .slice(0, slideCount);

    if (slides.length !== slideCount) {
      // Charge nothing when the model failed to deliver the full carousel.
      req.log.error(
        {
          model: textGen.model,
          governed: !!governed,
          slideCount,
          deliveredSlides: slides.length,
          rawLength: raw.length,
          parsedTopLevelKeys: Object.keys(parseModelJsonObject(raw) ?? {}),
        },
        "Carousel generation failed: incomplete carousel after retry",
      );
      await releaseFunding(req, captionFunding, "caption");
      if (governed) {
        await logCompiledPrompt({
          tenantId: req.tenantId,
          clerkUserId: req.clerkUserId,
          flowKey: "carousel",
          governed,
          generationContext: { platform, slideCount, model: textGen.model },
          success: false,
          latencyMs: Date.now() - startedAt,
        });
      }
      res.status(500).json({ error: "Failed to generate carousel" });
      return;
    }

    const spendPaise = await settleFunding(req, captionFunding, "caption", {
      requestBytes: Buffer.byteLength(systemPrompt + parsed.data.prompt),
      responseBytes: Buffer.byteLength(raw),
      durationMs: Date.now() - startedAt,
      model: textGen.model,
      campaignId: carouselId,
      platform,
      ...(await buildTextCostMeta(completion, textGen)),
    });
    if (governed) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "carousel",
        governed,
        generationContext: { platform, slideCount, model: textGen.model },
        success: true,
        latencyMs: Date.now() - startedAt,
        tokenUsage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens ?? 0,
              completionTokens: completion.usage.completion_tokens ?? 0,
              totalTokens: completion.usage.total_tokens ?? 0,
            }
          : null,
      });
    }
    res.json({
      title,
      caption,
      hashtags,
      slides,
      carouselId,
      ...(spendPaise !== null ? { spendPaise } : {}),
    });
  } catch (error) {
    await releaseFunding(req, captionFunding, "caption");
    if (governed) {
      await logCompiledPrompt({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        flowKey: "carousel",
        governed,
        generationContext: { platform, slideCount, model: textGen.model },
        success: false,
        latencyMs: Date.now() - startedAt,
      });
    }
    req.log.error({ err: error }, "Carousel generation failed");
    res.status(500).json({ error: "Failed to generate carousel" });
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
      res
        .status(400)
        .json({ error: "No audio file uploaded (field name: audio)" });
      return;
    }
    const mimeType = (file.mimetype || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(mimeType)) {
      res
        .status(400)
        .json({ error: `Unsupported audio type: ${mimeType || "unknown"}` });
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
