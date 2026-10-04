import sharp from "sharp";
import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import { imageGenFetch, errorDetail } from "../imageGen/types";
import { OPENAI_BUILTIN_MODEL } from "../imageGen/providers/openaiBuiltin";
import { getVideoGenProviderDef, resolveVideoGenApiKey } from "../videoGen";
import { buildImageCostMeta } from "../aiCost";
import { CUTOUT_PROMPT } from "../imageEditor/ops";
import type { UsageMeta } from "../usage";
import { logger } from "../logger";
import { assertPublicHost } from "../webFetch";
/** Only alpha is used: the source photo pixels never get regenerated. */
export const DEFAULT_MATTE_MODEL = "851-labs/background-remover";
export interface MatteResult {
  matte: Buffer; provider: "replicate" | "openai"; meta: Omit<UsageMeta, "funding">;
}
interface ReplicatePrediction { status?: string; output?: unknown; error?: unknown; urls?: { get?: string }; }
function outputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (output && typeof output === "object") {
    for (const value of Object.values(output as Record<string, unknown>)) {
      if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
    }
  }
  return null;
}
async function alphaOf(cutout: Buffer, width: number, height: number): Promise<Buffer> {
  const meta = await sharp(cutout).metadata();
  if (!meta.hasAlpha) throw new Error("Matte provider returned an image without transparency");
  const alpha = await sharp(cutout).ensureAlpha().extractChannel(3).resize(width, height, { fit: "fill" }).toColourspace("b-w").png().toBuffer();
  const stats = await sharp(alpha).stats();
  if (stats.channels[0]!.max < 128 || stats.channels[0]!.min > 250)
    throw new Error("Matte provider returned an empty or opaque cutout");
  return alpha;
}
async function replicateMatte(source: Buffer, width: number, height: number): Promise<MatteResult | null> {
  const def = getVideoGenProviderDef("replicate");
  const apiKey = (def ? await resolveVideoGenApiKey(def) : null) ?? process.env.REPLICATE_API_TOKEN ?? null;
  if (!apiKey) return null;
  const model = (process.env.COVER_MATTE_MODEL || DEFAULT_MATTE_MODEL).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(model)) throw new Error("Invalid cover matte model");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const startedAt = Date.now();
  const modelRes = await imageGenFetch(`https://api.replicate.com/v1/models/${model}`, { method: "GET", headers });
  if (!modelRes.ok) throw new Error(`Matte model lookup failed (${modelRes.status}): ${await errorDetail(modelRes)}`);
  const version = ((await modelRes.json()) as { latest_version?: { id?: string } }).latest_version?.id;
  if (!version) throw new Error(`Matte model ${model} has no published version`);
  const jpeg = await sharp(source).jpeg({ quality: 90 }).toBuffer();
  const res = await imageGenFetch("https://api.replicate.com/v1/predictions", {
    method: "POST", headers: { ...headers, Prefer: "wait=60" },
    body: JSON.stringify({ version, input: { image: `data:image/jpeg;base64,${jpeg.toString("base64")}` } }),
  });
  if (!res.ok) throw new Error(`Matte prediction failed (${res.status}): ${await errorDetail(res)}`);
  let prediction = (await res.json()) as ReplicatePrediction;
  const deadline = Date.now() + 60_000;
  while (prediction.status && ["starting", "processing"].includes(prediction.status) &&
    prediction.urls?.get && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const pollUrl = new URL(prediction.urls.get);
    if (pollUrl.origin !== "https://api.replicate.com" || !pollUrl.pathname.startsWith("/v1/predictions/") ||
      pollUrl.username || pollUrl.password) throw new Error("Invalid matte polling URL");
    const poll = await imageGenFetch(pollUrl.href, { method: "GET", headers, redirect: "error" });
    if (!poll.ok) throw new Error(`Matte polling failed (${poll.status})`);
    prediction = (await poll.json()) as ReplicatePrediction;
  }
  if (prediction.status !== "succeeded") {
    const detail = typeof prediction.error === "string" ? prediction.error.slice(0, 200) : prediction.status;
    throw new Error(`Matte prediction did not succeed: ${detail}`);
  }
  const url = outputUrl(prediction.output);
  if (!url) throw new Error("Matte prediction returned no image");
  const downloadUrl = new URL(url);
  if (downloadUrl.protocol !== "https:" || downloadUrl.username || downloadUrl.password)
    throw new Error("Invalid matte image URL");
  await assertPublicHost(downloadUrl.hostname);
  const img = await imageGenFetch(downloadUrl.href, { method: "GET", redirect: "error" });
  if (!img.ok) throw new Error(`Matte download failed (${img.status})`);
  const cutout = Buffer.from(await img.arrayBuffer());
  return {
    matte: await alphaOf(cutout, width, height), provider: "replicate",
    meta: { requestBytes: jpeg.length, responseBytes: cutout.length, durationMs: Date.now() - startedAt,
      model, provider: "replicate", routingReason: "cover subject matte" },
  };
}
const OPENAI_SIZES = [{ width: 1024, height: 1024 }, { width: 1536, height: 1024 }, { width: 1024, height: 1536 }] as const;
export function padForProvider(width: number, height: number): {
  canvas: { width: number; height: number }; pad: { left: number; top: number };
} {
  const ratio = width / height;
  let best: { width: number; height: number } = OPENAI_SIZES[0];
  for (const size of OPENAI_SIZES) {
    if (Math.abs(size.width / size.height - ratio) < Math.abs(best.width / best.height - ratio)) best = size;
  }
  const target = best.width / best.height;
  const canvas = ratio > target ? { width, height: Math.round(width / target) } : { width: Math.round(height * target), height };
  return { canvas, pad: { left: Math.floor((canvas.width - width) / 2), top: Math.floor((canvas.height - height) / 2) } };
}
async function openaiMatte(source: Buffer, width: number, height: number): Promise<MatteResult> {
  const startedAt = Date.now();
  const { canvas, pad } = padForProvider(width, height);
  const padded = await sharp(source).extend({
    left: pad.left, right: canvas.width - width - pad.left, top: pad.top,
    bottom: canvas.height - height - pad.top, extendWith: "mirror",
  }).png().toBuffer();
  const response = await openai.images.edit({
    model: OPENAI_BUILTIN_MODEL, image: await toFile(padded, "source.png", { type: "image/png" }),
    prompt: CUTOUT_PROMPT, background: "transparent",
  });
  const b64 = response.data?.[0]?.b64_json ?? "";
  if (!b64) throw new Error("The image provider returned no cutout");
  const cutout = Buffer.from(b64, "base64");
  const fullAlpha = await alphaOf(cutout, canvas.width, canvas.height);
  const matte = await sharp(fullAlpha).extract({ left: pad.left, top: pad.top, width, height }).png().toBuffer();
  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return {
    matte, provider: "openai",
    meta: {
      requestBytes: padded.length, responseBytes: cutout.length, durationMs: Date.now() - startedAt,
      model: OPENAI_BUILTIN_MODEL, routingReason: "cover subject matte (fallback)",
      ...(await buildImageCostMeta({
        provider: "openai", model: OPENAI_BUILTIN_MODEL,
        usage: usage ? {
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
        } : undefined,
      })),
    },
  };
}
export async function extractSubjectMatte(source: Buffer): Promise<MatteResult | null> {
  const oriented = await sharp(source).rotate().removeAlpha().png().toBuffer();
  const meta = await sharp(oriented).metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  if (!width || !height) return null;
  try {
    const result = await replicateMatte(oriented, width, height);
    if (result) return result;
  } catch (err) { logger.warn({ err }, "Replicate cover matte failed; trying the built-in provider"); }
  try { return await openaiMatte(oriented, width, height); }
  catch (err) { logger.warn({ err }, "Cover matte unavailable; the cover will use text-over layout"); return null; }
}