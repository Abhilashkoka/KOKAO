import { aiFallbackSettingsTable, db } from "@workspace/db";

export const EDITABLE_AI_FALLBACK_FAMILIES = [
  "image",
  "text",
  "text-to-video",
  "image-to-video",
  "tts",
  "asr",
] as const;

export type EditableAiFallbackFamily = (typeof EDITABLE_AI_FALLBACK_FAMILIES)[number];
export type AiFallbackOrders = Partial<Record<EditableAiFallbackFamily, string[]>>;

function validOrders(value: unknown): AiFallbackOrders {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AiFallbackOrders = {};
  for (const family of EDITABLE_AI_FALLBACK_FAMILIES) {
    const ids = (value as Record<string, unknown>)[family];
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
      out[family] = [...new Set(ids)];
    }
  }
  return out;
}

/** Undefined means no manual order was saved, preserving historical routing. */
export async function getAiFallbackOrders(): Promise<AiFallbackOrders> {
  const row = (await db.select().from(aiFallbackSettingsTable).limit(1))[0];
  return validOrders(row?.orders);
}

export async function setAiFallbackOrders(orders: AiFallbackOrders): Promise<void> {
  const normalized = validOrders(orders);
  await db.insert(aiFallbackSettingsTable).values({ id: 1, orders: normalized })
    .onConflictDoUpdate({
      target: aiFallbackSettingsTable.id,
      set: { orders: normalized, updatedAt: new Date() },
    });
}

/**
 * An absent key means historical ordering. A present key is an exact chain:
 * [] deliberately disables fallover and unknown ids are never appended.
 */
export function applyManualOrder<T>(items: readonly T[], order: string[] | undefined, id: (item: T) => string): T[] {
  if (!order) return [...items];
  const byId = new Map(items.map((item) => [id(item), item]));
  return order.flatMap((value) => {
    const item = byId.get(value);
    return item === undefined ? [] : [item];
  });
}