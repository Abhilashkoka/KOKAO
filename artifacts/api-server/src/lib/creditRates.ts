import {
  db,
  creditRatesTable,
  creditMeterSettingsTable,
  type CreditRate,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";

/**
 * The credit rate card: how many credits one unit of each billable action
 * costs, and the platform-wide meter mode.
 *
 * Everything here is superadmin-configured data, cached in-process because it
 * is read on the hot path of every provider call and changes a few times a
 * month at most. `invalidateCreditRateCache()` runs on every write.
 */

/** Credits per unit, in thousandths. 1000 milli-credits = 1 credit. */
export const MILLI = 1000;

export type CreditRateUnit = "item" | "second";
export type MeterMode = "off" | "shadow" | "enforce";

export interface CreditRateView {
  key: string;
  label: string;
  unit: CreditRateUnit;
  /** Credits per unit as a decimal, e.g. 0.2 — what the admin card shows. */
  credits: number;
  active: boolean;
  sortOrder: number;
  notes: string | null;
}

/**
 * Seeded on first read so a fresh install has a working, self-explanatory card
 * rather than an empty table. Calibrated against the anchor 1 credit = 1
 * second of standard-resolution video; every other row is priced relative to
 * that. Superadmins are expected to change these — they are a starting point,
 * not a recommendation.
 */
export const DEFAULT_CREDIT_RATES: ReadonlyArray<
  Omit<CreditRateView, "notes"> & { notes: string }
> = [
  {
    key: "video",
    label: "Video generation",
    unit: "second",
    credits: 1,
    active: true,
    sortOrder: 10,
    notes: "The anchor: 1 credit = 1 second of finished standard-resolution video.",
  },
  {
    key: "video_hd",
    label: "Video generation (HD)",
    unit: "second",
    credits: 1.5,
    active: true,
    sortOrder: 20,
    notes: "Higher-resolution delivery, priced as a multiple of the video anchor.",
  },
  {
    key: "image",
    label: "Image generation",
    unit: "item",
    credits: 3,
    active: true,
    sortOrder: 30,
    notes: "One generated image, including the scene keyframes made inside a video job.",
  },
  {
    key: "image_edit",
    label: "Image edit",
    unit: "item",
    credits: 3,
    active: true,
    sortOrder: 40,
    notes: "One edit pass over an existing image.",
  },
  {
    key: "caption",
    label: "Caption / text generation",
    unit: "item",
    credits: 0.2,
    active: true,
    sortOrder: 50,
    notes: "One text generation: caption, script, storyboard plan or narration.",
  },
  {
    key: "voice",
    label: "Voice / narration",
    unit: "second",
    credits: 0.1,
    active: true,
    sortOrder: 60,
    notes: "Text-to-speech and voice cloning, per second of audio produced.",
  },
  {
    key: "lipsync",
    label: "Lip sync",
    unit: "second",
    credits: 2,
    active: true,
    sortOrder: 70,
    notes: "Per second of lip-synced output. Set to 0 until a provider is wired up.",
  },
  {
    key: "transcription",
    label: "Transcription (ASR)",
    unit: "second",
    credits: 0.05,
    active: true,
    sortOrder: 80,
    notes: "Per second of audio transcribed.",
  },
];

const MODE_ROW_ID = 1;

let rateCache: Map<string, CreditRate> | null = null;
let modeCache: MeterMode | null = null;

export function invalidateCreditRateCache(): void {
  rateCache = null;
  modeCache = null;
}

function toView(row: CreditRate): CreditRateView {
  return {
    key: row.key,
    label: row.label,
    unit: row.unit === "second" ? "second" : "item",
    credits: row.creditsMilli / MILLI,
    active: row.active,
    sortOrder: row.sortOrder,
    notes: row.notes,
  };
}

/**
 * Insert the default card exactly once. `onConflictDoNothing` on the unique
 * key makes this safe to run concurrently and safe to re-run after a
 * superadmin has edited or deleted rows: an existing key is never overwritten,
 * and a deleted key is not resurrected on the same boot because the seed only
 * runs when the table is completely empty.
 */
async function seedIfEmpty(): Promise<void> {
  const existing = await db.select({ id: creditRatesTable.id }).from(creditRatesTable).limit(1);
  if (existing.length > 0) return;
  await db
    .insert(creditRatesTable)
    .values(
      DEFAULT_CREDIT_RATES.map((r) => ({
        key: r.key,
        label: r.label,
        unit: r.unit,
        creditsMilli: Math.round(r.credits * MILLI),
        active: r.active,
        sortOrder: r.sortOrder,
        notes: r.notes,
      })),
    )
    .onConflictDoNothing({ target: creditRatesTable.key });
}

async function loadRates(): Promise<Map<string, CreditRate>> {
  if (rateCache) return rateCache;
  await seedIfEmpty();
  const rows = await db
    .select()
    .from(creditRatesTable)
    .orderBy(asc(creditRatesTable.sortOrder), asc(creditRatesTable.id));
  const map = new Map<string, CreditRate>();
  for (const row of rows) map.set(row.key, row);
  rateCache = map;
  return map;
}

/** The full card, in admin display order. */
export async function listCreditRates(): Promise<CreditRateView[]> {
  const rows = [...(await loadRates()).values()];
  return rows.map(toView);
}

export interface UpsertCreditRateInput {
  key: string;
  label: string;
  unit: CreditRateUnit;
  credits: number;
  active: boolean;
  sortOrder?: number;
  notes?: string | null;
}

/**
 * Create or update one rate. Keyed on `key`, so saving the card is a series of
 * idempotent upserts and a superadmin can add a cost centre KOKAO does not yet
 * have a meter call for — the row simply sits unused until one exists.
 */
export async function upsertCreditRate(
  input: UpsertCreditRateInput,
): Promise<CreditRateView> {
  const creditsMilli = Math.max(0, Math.round((Number(input.credits) || 0) * MILLI));
  const values = {
    key: input.key,
    label: input.label,
    unit: input.unit,
    creditsMilli,
    active: input.active,
    sortOrder: input.sortOrder ?? 0,
    notes: input.notes ?? null,
  };
  const [row] = await db
    .insert(creditRatesTable)
    .values(values)
    .onConflictDoUpdate({
      target: creditRatesTable.key,
      set: {
        label: values.label,
        unit: values.unit,
        creditsMilli: values.creditsMilli,
        active: values.active,
        sortOrder: values.sortOrder,
        notes: values.notes,
        updatedAt: new Date(),
      },
    })
    .returning();
  invalidateCreditRateCache();
  return toView(row);
}

/** Remove a rate. Historical meter events keep their recorded key and price. */
export async function deleteCreditRate(key: string): Promise<boolean> {
  const deleted = await db
    .delete(creditRatesTable)
    .where(eq(creditRatesTable.key, key))
    .returning({ id: creditRatesTable.id });
  invalidateCreditRateCache();
  return deleted.length > 0;
}

/**
 * What `quantity` units of `key` cost, in milli-credits.
 *
 * Returns null when no rate exists for the key — the caller records the call
 * anyway at zero, so an unpriced action shows up as a gap in the report rather
 * than silently costing nothing. An INACTIVE rate deliberately returns 0, not
 * null: it is a priced-at-free action, not an unknown one.
 */
export async function creditsMilliFor(
  key: string,
  quantity: number,
): Promise<number | null> {
  const rate = (await loadRates()).get(key);
  if (!rate) return null;
  if (!rate.active) return 0;
  const q = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
  return Math.round(q * rate.creditsMilli);
}

/** The platform-wide meter mode. Defaults to "shadow" when unset. */
export async function getMeterMode(): Promise<MeterMode> {
  if (modeCache) return modeCache;
  const [row] = await db
    .select()
    .from(creditMeterSettingsTable)
    .orderBy(asc(creditMeterSettingsTable.id))
    .limit(1);
  const mode: MeterMode =
    row?.mode === "off" ? "off" : row?.mode === "enforce" ? "enforce" : "shadow";
  modeCache = mode;
  return mode;
}

export async function setMeterMode(mode: MeterMode): Promise<MeterMode> {
  await db
    .insert(creditMeterSettingsTable)
    .values({ id: MODE_ROW_ID, mode })
    .onConflictDoUpdate({
      target: creditMeterSettingsTable.id,
      set: { mode, updatedAt: new Date() },
    });
  invalidateCreditRateCache();
  return mode;
}
