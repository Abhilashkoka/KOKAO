import type OpenAI from "openai";
import { meter, type MeterContext } from "./meter";

type CreateParams = Record<string, unknown>;
export type TextCreateFn = (params: CreateParams, options?: unknown) => Promise<unknown>;

export async function meterTextCreate(
  rawCreate: TextCreateFn,
  params: CreateParams,
  options: unknown,
  context: MeterContext | null,
  provider: string,
  model: string,
  operationKey: string | null,
): Promise<unknown> {
  return meter(
    context
      ? {
          ...context,
          provider,
          model,
          operationKey,
          operationFamilyKey: operationKey,
        }
      : null,
    "caption",
    1,
    () => rawCreate(params, options),
    (result) => {
      const usage = (result as {
        usage?: { completion_tokens?: number; output_tokens?: number };
      })?.usage;
      const tokens = usage?.completion_tokens ?? usage?.output_tokens;
      return typeof tokens === "number" ? { tokens } : null;
    },
  );
}

/**
 * Meter the actual chat-completions transport, rather than a higher-level
 * feature call. This is intentionally applied before failover so a paid
 * primary failure and its paid fallback are both visible.
 */
export function withTextMeter(
  client: OpenAI,
  context: MeterContext | null,
  provider: string,
  model: string,
): OpenAI {
  const rawCreate = client.chat.completions.create.bind(client.chat.completions) as unknown as TextCreateFn;
  let callNumber = 0;
  const create: TextCreateFn = async (params, options) => {
    callNumber += 1;
    const operationKey = context?.operationKey
      ? `${context.operationKey}:text:${callNumber}`
      : null;
    return meterTextCreate(rawCreate, params, options, context, provider, model, operationKey);
  };

  return {
    baseURL: (client as { baseURL?: string }).baseURL,
    chat: { completions: { create } },
  } as unknown as OpenAI;
}