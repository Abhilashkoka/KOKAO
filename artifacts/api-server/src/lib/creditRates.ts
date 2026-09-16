import {
  db,
  creditRatesTable,
  creditMeterSettingsTable,
  type CreditRate,
} from "@workspace/db";
import { asc, eq, inArray, not } from "drizzle-orm";
import {
  creditEnforcementLockReason,
  isCreditEnforcementAllowed,
} from "./creditReconciliationGate";

/**
 * The credit rate card: how many credits one unit of each billable action
 * costs, and the platform-wide meter mode.
 *
 * Everything here is superadmin-configured data, cached briefly in-process
 * because it is read on the hot path of every provider call. The bounded TTL
 * below limits stale values in another worker; `invalidateCreditRateCache()`
 * still runs on every local write.
 */

/** Credits per unit, in thousandths. 1000 milli-credits = 1 credit. */
export const MILLI = 1000;

export type CreditRateUnit = "item" | "second";
export type MeterMode = "off" | "shadow" | "enforce";

/**
 * Historical wallet migration used CREDIT_PRICE_PAISE (₹45 per credit when
 * unset). Keep that fallback for an installation that has not yet written the
 * additive persisted setting; once the settings row exists, its value is
 * authoritative.
 */
const configuredDefaultCreditPricePaise = Number(process.env.CREDIT_PRICE_PAISE ?? 4500);
export const DEFAULT_CREDIT_PRICE_PAISE =
  Number.isSafeInteger(configuredDefaultCreditPricePaise) &&
  configuredDefaultCreditPricePaise > 0
    ? configuredDefaultCreditPricePaise
    : 4500;

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

/** Every provider rail currently supported by the meter must have a saved,
 * active row before the platform can enter enforce mode. */
export const REQUIRED_CREDIT_RATE_KEYS: ReadonlyArray<string> = Object.freeze(
  DEFAULT_CREDIT_RATES.map((rate) => rate.key),
);

const MODE_ROW_ID = 1;
export const CREDIT_RATE_CACHE_TTL_MS = 5_000;

let rateCache: Map<string, CreditRate> | null = null;
let rateCacheLoadedAt = 0;
let modeCache: MeterMode | null = null;
let modeCacheLoadedAt = 0;
let creditPricePaiseCache: number | null = null;
let creditPricePaiseCacheLoadedAt = 0;

export class CreditEnforcementLockedError extends Error {
  readonly code = "CREDIT_ENFORCEMENT_LOCKED";

  constructor() {
    super(`Credit enforcement is locked: ${creditEnforcementLockReason()}`);
    this.name = "CreditEnforcementLockedError";
  }
}

export class CreditRateCardValidationError extends Error {
  readonly code = "CREDIT_RATE_CARD_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CreditRateCardValidationError";
  }
}

export function invalidateCreditRateCache(): void {
  rateCache = null;
  rateCacheLoadedAt = 0;
  modeCache = null;
  modeCacheLoadedAt = 0;
  creditPricePaiseCache = null;
  creditPricePaiseCacheLoadedAt = 0;
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
  if (
    rateCache &&
    Date.now() - rateCacheLoadedAt < CREDIT_RATE_CACHE_TTL_MS
  ) {
    return rateCache;
  }
  await seedIfEmpty();
  const rows = await db
    .select()
    .from(creditRatesTable)
    .orderBy(asc(creditRatesTable.sortOrder), asc(creditRatesTable.id));
  const map = new Map<string, CreditRate>();
  for (const row of rows) map.set(row.key, row);
  rateCache = map;
  rateCacheLoadedAt = Date.now();
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

interface NormalizedCreditRateInput {
  key: string;
  label: string;
  unit: CreditRateUnit;
  creditsMilli: number;
  active: boolean;
  sortOrder: number;
  notes: string | null;
}

function normalizeCreditRateInput(
  input: UpsertCreditRateInput,
): NormalizedCreditRateInput {
  const credits = input.credits;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
    throw new CreditRateCardValidationError(
      "Credit rate must be a finite number that is 0 or more.",
    );
  }
  const creditsMilli = Math.round(credits * MILLI);
  if (!Number.isSafeInteger(creditsMilli)) {
    throw new CreditRateCardValidationError(
      "Credit rate is outside the supported precision range.",
    );
  }
  if (credits > 0 && creditsMilli === 0) {
    throw new CreditRateCardValidationError(
      "Credit rate must be 0 or at least 0.001 credits.",
    );
  }
  if (
    typeof input.key !== "string" ||
    input.key.length === 0 ||
    typeof input.label !== "string" ||
    input.label.length === 0 ||
    (input.unit !== "item" && input.unit !== "second") ||
    typeof input.active !== "boolean"
  ) {
    throw new CreditRateCardValidationError("Credit rate fields are invalid.");
  }
  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
    throw new CreditRateCardValidationError(
      "Credit rate sort order must be a non-negative whole number.",
    );
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== "string") {
    throw new CreditRateCardValidationError("Credit rate notes are invalid.");
  }
  return {
    key: input.key,
    label: input.label,
    unit: input.unit,
    creditsMilli,
    active: input.active,
    sortOrder,
    notes: input.notes ?? null,
  };
}

/**
 * Create or update one rate. Keyed on `key`, so saving the card is a series of
 * idempotent upserts and a superadmin can add a cost centre KOKAO does not yet
 * have a meter call for — the row simply sits unused until one exists.
 */
export async function upsertCreditRate(
  input: UpsertCreditRateInput,
): Promise<CreditRateView> {
  const normalized = normalizeCreditRateInput(input);
  const values = {
    ...normalized,
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

export interface ReplaceCreditRateCardInput {
  mode: MeterMode;
  creditPricePaise: number;
  rates: ReadonlyArray<UpsertCreditRateInput>;
}

function validateCreditPricePaise(value: unknown): asserts value is number {
  if (!validCreditPricePaise(value)) {
    throw new CreditRateCardValidationError(
      "Credit price must be a positive whole number of paise.",
    );
  }
}

export function validateCreditRateCard(
  input: ReplaceCreditRateCardInput,
): void {
  if (input.mode !== "off" && input.mode !== "shadow" && input.mode !== "enforce") {
    throw new CreditRateCardValidationError("Meter mode is invalid.");
  }
  validateCreditPricePaise(input.creditPricePaise);
  const rates = input.rates.map(normalizeCreditRateInput);
  const keys = rates.map((rate) => rate.key);
  if (new Set(keys).size !== keys.length) {
    throw new CreditRateCardValidationError("Rate keys must be unique.");
  }
  if (input.mode === "enforce") {
    const byKey = new Map(rates.map((rate) => [rate.key, rate]));
    const missing = REQUIRED_CREDIT_RATE_KEYS.filter((key) => !byKey.has(key));
    const inactive = REQUIRED_CREDIT_RATE_KEYS.filter(
      (key) => byKey.get(key)?.active !== true,
    );
    if (missing.length > 0 || inactive.length > 0) {
      const problems = [
        ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
        ...(inactive.length > 0 ? [`inactive: ${inactive.join(", ")}`] : []),
      ];
      throw new CreditRateCardValidationError(
        `Enforce mode requires every supported rate to be saved and active (${problems.join("; ")}).`,
      );
    }
  }
}

/**
 * Replace the persisted mode, conversion price and complete rate card in one
 * database transaction. Validation happens before opening the transaction so a
 * malformed later row cannot leave earlier rows written. The enforce check is
 * deliberately scoped to the current runtime release decision.
 */
export async function replaceCreditRateCard(
  input: ReplaceCreditRateCardInput,
): Promise<void> {
  validateCreditRateCard(input);
  const rates = input.rates.map(normalizeCreditRateInput);
  const keys = rates.map((rate) => rate.key);
  if (input.mode === "enforce" && !isCreditEnforcementAllowed()) {
    throw new CreditEnforcementLockedError();
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(creditMeterSettingsTable)
      .values({
        id: MODE_ROW_ID,
        mode: input.mode,
        creditPricePaise: input.creditPricePaise,
      })
      .onConflictDoUpdate({
        target: creditMeterSettingsTable.id,
        set: {
          mode: input.mode,
          creditPricePaise: input.creditPricePaise,
          updatedAt: new Date(),
        },
      });

    for (const rate of rates) {
      await tx
        .insert(creditRatesTable)
        .values(rate)
        .onConflictDoUpdate({
          target: creditRatesTable.key,
          set: {
            label: rate.label,
            unit: rate.unit,
            creditsMilli: rate.creditsMilli,
            active: rate.active,
            sortOrder: rate.sortOrder,
            notes: rate.notes,
            updatedAt: new Date(),
          },
        });
    }

    const rateDelete = tx.delete(creditRatesTable);
    if (keys.length === 0) {
      await rateDelete;
    } else {
      await rateDelete.where(not(inArray(creditRatesTable.key, keys)));
    }
  });
  invalidateCreditRateCache();
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
 * Returns null when no rate exists for the key — shadow reporting records the
 * call at zero so an unpriced action shows up as a gap rather than vanishing.
 * An INACTIVE rate deliberately returns 0, not null, for display/reporting
 * compatibility; the enforced provider meter separately refuses it before
 * dispatch. Only an explicitly ACTIVE zero rate is a valid free operation.
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

/** Immutable pricing inputs for one provider dispatch. */
export interface CreditCostSnapshot {
  unitRateMilli: number;
  costMilli: number;
  /** True when the saved row is enabled for provider work. */
  active: boolean;
  /** False when a corrupted/non-finite saved price cannot be used safely. */
  valid: boolean;
}

export async function creditCostSnapshotFor(
  key: string,
  quantity: number,
): Promise<CreditCostSnapshot | null> {
  const rate = (await loadRates()).get(key);
  if (!rate) return null;
  const valid =
    Number.isSafeInteger(rate.creditsMilli) &&
    rate.creditsMilli >= 0 &&
    (rate.unit === "item" || rate.unit === "second");
  const unitRateMilli = rate.active && valid ? rate.creditsMilli : 0;
  const q = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
  return {
    unitRateMilli,
    costMilli: Math.round(q * unitRateMilli),
    active: rate.active,
    valid,
  };
}

function effectiveMeterMode(mode: MeterMode): MeterMode {
  // A persisted enforce row is not enough to charge: production needs the
  // explicit saved-rate rollout authorization, while local development needs
  // its separate opt-in and runtime identity check. Provider-invoice
  // reconciliation remains a separate reporting verdict.
  return mode === "enforce" && !isCreditEnforcementAllowed()
    ? "shadow"
    : mode;
}

/** The platform-wide meter mode. Defaults to "shadow" when unset. */
export async function getMeterMode(): Promise<MeterMode> {
  if (
    modeCache !== null &&
    Date.now() - modeCacheLoadedAt < CREDIT_RATE_CACHE_TTL_MS
  ) {
    // Apply the release gate even to a value left in the in-process cache by
    // an earlier version or a stale worker.
    return effectiveMeterMode(modeCache);
  }
  const [row] = await db
    .select()
    .from(creditMeterSettingsTable)
    .orderBy(asc(creditMeterSettingsTable.id))
    .limit(1);
  const storedMode: MeterMode =
    row?.mode === "off" ? "off" : row?.mode === "enforce" ? "enforce" : "shadow";
  modeCache = storedMode;
  modeCacheLoadedAt = Date.now();
  return effectiveMeterMode(storedMode);
}

export async function setMeterMode(mode: MeterMode): Promise<MeterMode> {
  if (mode === "enforce" && !isCreditEnforcementAllowed()) {
    throw new CreditEnforcementLockedError();
  }
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

function validCreditPricePaise(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * The persisted rupee price of one credit. This is intentionally separate
 * from the provider rate card: changing it only affects conversion of legacy
 * rupee balances, never the explicit credits in a purchased pack or an
 * immutable meter event snapshot.
 */
export async function getCreditPricePaise(): Promise<number> {
  if (
    creditPricePaiseCache !== null &&
    Date.now() - creditPricePaiseCacheLoadedAt < CREDIT_RATE_CACHE_TTL_MS
  ) {
    return creditPricePaiseCache;
  }
  const [row] = await db
    .select({ creditPricePaise: creditMeterSettingsTable.creditPricePaise })
    .from(creditMeterSettingsTable)
    .orderBy(asc(creditMeterSettingsTable.id))
    .limit(1);
  creditPricePaiseCache = validCreditPricePaise(row?.creditPricePaise)
    ? row.creditPricePaise
    : DEFAULT_CREDIT_PRICE_PAISE;
  creditPricePaiseCacheLoadedAt = Date.now();
  return creditPricePaiseCache;
}

export async function setCreditPricePaise(pricePaise: number): Promise<number> {
  if (!validCreditPricePaise(pricePaise)) {
    throw new Error("Credit price must be a positive whole number of paise.");
  }
  await db
    .insert(creditMeterSettingsTable)
    .values({ id: MODE_ROW_ID, creditPricePaise: pricePaise })
    .onConflictDoUpdate({
      target: creditMeterSettingsTable.id,
      set: { creditPricePaise: pricePaise, updatedAt: new Date() },
    });
  invalidateCreditRateCache();
  return pricePaise;
}
