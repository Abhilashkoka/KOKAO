import type { BrandKitPayload, Tenant } from "@workspace/db";
import { getTextGenClient } from "../textGen";
import { loadActivePayload } from "../brandKit/service";
import { logger } from "../logger";
import { parseModelJsonObject } from "../modelJson";
import { HEADLINE_MAX_CHARS, KICKER_MAX_CHARS, SUBLINE_MAX_CHARS, normalizeCoverCopy, type CoverCopy } from "./types";
const SYSTEM_PROMPT = [
  "You write cover text for Instagram posts styled like magazine covers.",
  'Return ONLY JSON: {"kicker": string, "headline": string, "subline": string}.',
  "",
  `headline: the hero. 1 to 3 words, at most ${Math.min(14, HEADLINE_MAX_CHARS)} characters. Concrete and curiosity-driven, a noun phrase beats a sentence ("Personality Upgrades", "Sales Tricks", "Skin Routine", "AI"). No punctuation, no emoji, no hashtags.`,
  `kicker: 0 to 3 lowercase-led words that lead into the headline ("My", "The art of", "Let", "10 ways to"). At most ${KICKER_MAX_CHARS} characters. May be empty.`,
  `subline: the payoff, at most 7 words and ${SUBLINE_MAX_CHARS} characters, sentence case, no trailing full stop ("that actually work", "what most people get wrong").`,
  "", "Hard rules:",
  "- Never name or allude to real public figures, celebrities, film or TV characters, or other companies' brands.",
  "- For doctors, clinics and other regulated professionals: no claims of cure, guaranteed results, superlatives (best, No.1, top), prices, discounts, or before/after promises. Educational framing only.",
  "- Write in the language of the topic.",
].join("\n");
const STOPWORDS = new Set("a an the and or but of to in on for with at by from how why what when is are was were be being been your my our their this that these those it its into about as do does did you we i".split(" "));
function titleCase(word: string): string {
  return word.length <= 3 && word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1);
}
export function splitTopicIntoCopy(topic: string): CoverCopy {
  const words = topic.replace(/[#*_"“”]/g, "").replace(/[.!?]+$/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kicker: "", headline: "", subline: "" };
  const firstContent = words.findIndex((w) => !STOPWORDS.has(w.toLowerCase()));
  const start = firstContent === -1 ? 0 : firstContent;
  const headlineWords: string[] = [];
  for (let i = start; i < words.length && headlineWords.length < 2; i += 1) {
    const word = words[i]!;
    if (headlineWords.length > 0 && STOPWORDS.has(word.toLowerCase())) break;
    const next = [...headlineWords, word].join(" ");
    if (next.length > 14 && headlineWords.length > 0) break;
    headlineWords.push(word);
  }
  const kicker = words.slice(Math.max(0, start - 3), start).join(" ");
  const rest = words.slice(start + headlineWords.length, start + headlineWords.length + 7).join(" ");
  return normalizeCoverCopy({
    kicker: kicker ? kicker.charAt(0).toUpperCase() + kicker.slice(1) : "",
    headline: headlineWords.map(titleCase).join(" "), subline: rest,
  });
}
function brandLine(brand: BrandKitPayload | null): string {
  if (!brand) return "";
  const parts = [`Brand: ${brand.identity.brand_name}`];
  if (brand.identity.industry) parts.push(`industry: ${brand.identity.industry}`);
  if (brand.identity.audience.length) parts.push(`audience: ${brand.identity.audience.slice(0, 3).join(", ")}`);
  if (brand.voice.traits.length) parts.push(`voice: ${brand.voice.traits.slice(0, 4).join(", ")}`);
  if (brand.voice.donts.length) parts.push(`avoid: ${brand.voice.donts.slice(0, 4).join("; ")}`);
  return parts.join(" | ");
}
export async function draftCoverCopy(input: {
  tenantId: number; tenant: Tenant; topic: string; brandKitId: number | null;
}): Promise<{ copy: CoverCopy; source: "ai" | "fallback" }> {
  const fallback = () => ({ copy: splitTopicIntoCopy(input.topic), source: "fallback" as const });
  try {
    const brand = (await loadActivePayload(input.tenantId, input.brandKitId).catch(() => null))?.payload ?? null;
    const textGen = await getTextGenClient(input.tenant.aiModel, null);
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [`Topic: ${input.topic}`, brandLine(brand)].filter(Boolean).join("\n") },
      ],
      max_completion_tokens: 300, response_format: { type: "json_object" },
    });
    const parsed = parseModelJsonObject(completion.choices[0]?.message?.content ?? "");
    if (!parsed) return fallback();
    const copy = normalizeCoverCopy(parsed as Record<string, unknown>);
    if (!copy.headline) return fallback();
    return { copy, source: "ai" };
  } catch (err) {
    logger.warn({ err }, "Cover copy drafting failed; using the deterministic split");
    return fallback();
  }
}