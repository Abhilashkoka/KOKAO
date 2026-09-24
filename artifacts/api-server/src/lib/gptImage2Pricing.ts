/**
 * Official standard (not Batch) GPT Image 2 rates:
 * https://developers.openai.com/api/docs/pricing#image-generation
 * Text input $2.50/M; image input $4/M; image output $15/M.
 *
 * The catalog's input column holds IMAGE input pricing, matching OpenAI's
 * catalog importer. Never multiply aggregate mixed input tokens by that rate.
 * These are uncached catalog estimates, not provider-reported billed USD.
 */
export function gptImage2TokenCostUsd(args: {
  inputTokens: number;
  outputTokens: number;
  inputTokenDetails?: { text_tokens?: number; image_tokens?: number };
  imageInputUsdPerMtok: number;
  outputUsdPerMtok: number;
}): number | null {
  const text = args.inputTokenDetails?.text_tokens;
  const image = args.inputTokenDetails?.image_tokens;
  if (
    text === undefined || image === undefined ||
    ![text, image, args.inputTokens, args.outputTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    text + image !== args.inputTokens
  ) return null;
  return (
    text * 2.5 +
    image * args.imageInputUsdPerMtok +
    args.outputTokens * args.outputUsdPerMtok
  ) / 1_000_000;
}