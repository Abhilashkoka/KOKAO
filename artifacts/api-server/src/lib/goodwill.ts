import {
  db,
  creditAccountLedgerTable,
  goodwillSettingsTable,
} from "@workspace/db";
import { and, eq, gte, like, sql } from "drizzle-orm";
import { grantCredits, isCreditFunded } from "./creditAccounts";
import { MILLI } from "./creditRates";
import { logger } from "./logger";

/**
 * Goodwill: free fixes KOKAO pays for.
 *
 * Users should not pay for the AI's mistakes. Two fixes are free:
 *
 *   - the first N storyboard image redos of a video (default 1), and
 *   - the first S seconds of the first picture Smart Edit of a video
 *     (default 3; New line edits are always charged).
 *
 * How "free" works: just before the fix starts, the workspace is granted
 * exactly the credits the free part will cost (ledger kind `goodwill`, into
 * the expiring bucket with a one-day life). The meter then charges the fix as
 * usual — granted credits are spent first — so every provider call is still
 * recorded at its true cost and the existing refund paths are untouched. The
 * user's balance moves only by the part that is not free.
 *
 * Guard rails, all in one transaction under a per-workspace lock:
 *   - kill switch, credit-funded workspaces only;
 *   - per-video limits enforced by idempotency keys
 *     (`goodwill:smart-edit:<jobId>`, `goodwill:image-redo:<jobId>:<n>`), so
 *     a video can never get a second free Smart Edit, across all its versions;
 *   - a monthly goodwill budget per workspace;
 *   - a platform-wide daily alarm to superadmins.
 *
 * If a free fix fails or never starts, the granted credits stay on the
 * balance for a day (and a failed spend is refunded as usual). That leak is
 * bounded by the per-video key and the monthly budget, and it is in the
 * customer's favour, which is the point of goodwill.
 */

export interface GoodwillSettings {
  enabled: boolean;
  freeImageRedosPerVideo: number;
  freeSmartEditSeconds: number;
  monthlyBudgetCredits: number;
  dailyAlarmCredits: number;
}

export const DEFAULT_GOODWILL_SETTINGS: GoodwillSettings = {
  enabled: true,
  freeImageRedosPerVideo: 1,
  freeSmartEditSeconds: 3,
  monthlyBudgetCredits: 50,
  dailyAlarmCredits: 500,
};

const SETTINGS_ROW_ID = 1;
/** Goodwill credits live one day: long enough to fund the fix they are for. */
const GOODWILL_EXPIRES_IN_DAYS = 1;
export const GOODWILL_REF_KIND = "videoJobGoodwill";

const LIMITS = {
  freeImageRedosPerVideo: 20,
  freeSmartEditSeconds: 12,
  monthlyBudgetCredits: 1_000_000,
  dailyAlarmCredits: 100_000_000,
} as const;

export async function getGoodwillSettings(): Promise<GoodwillSettings> {
  const [row] = await db
    .select()
    .from(goodwillSettingsTable)
    .where(eq(goodwillSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);
  if (!row) return { ...DEFAULT_GOODWILL_SETTINGS };
  return {
    enabled: row.enabled,
    freeImageRedosPerVideo: row.freeImageRedosPerVideo,
    freeSmartEditSeconds: row.freeSmartEditSeconds,
    monthlyBudgetCredits: row.monthlyBudgetCredits,
    dailyAlarmCredits: row.dailyAlarmCredits,
  };
}

export class GoodwillSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoodwillSettingsError";
  }
}

export function validateGoodwillSettings(input: GoodwillSettings): GoodwillSettings {
  const whole = (value: unknown, max: number, label: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
      throw new GoodwillSettingsError(`${label} must be a whole number from 0 to ${max.toLocaleString("en-IN")}.`);
    }
    return value as number;
  };
  if (typeof input.enabled !== "boolean") {
    throw new GoodwillSettingsError("Enabled must be true or false.");
  }
  return {
    enabled: input.enabled,
    freeImageRedosPerVideo: whole(input.freeImageRedosPerVideo, LIMITS.freeImageRedosPerVideo, "Free image redos per video"),
    freeSmartEditSeconds: whole(input.freeSmartEditSeconds, LIMITS.freeSmartEditSeconds, "Free Smart Edit seconds"),
    monthlyBudgetCredits: whole(input.monthlyBudgetCredits, LIMITS.monthlyBudgetCredits, "Monthly budget per workspace"),
    dailyAlarmCredits: whole(input.dailyAlarmCredits, LIMITS.dailyAlarmCredits, "Daily alarm"),
  };
}

export async function setGoodwillSettings(input: GoodwillSettings): Promise<GoodwillSettings> {
  const next = validateGoodwillSettings(input);
  await db
    .insert(goodwillSettingsTable)
    .values({ id: SETTINGS_ROW_ID, ...next })
    .onConflictDoUpdate({
      target: goodwillSettingsTable.id,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function goodwillMilliSince(
  executor: Tx | typeof db,
  since: Date,
  tenantId?: number,
): Promise<number> {
  const [row] = await executor
    .select({
      total: sql<string>`COALESCE(SUM(${creditAccountLedgerTable.grantedDeltaMilli} + ${creditAccountLedgerTable.purchasedDeltaMilli}), 0)`,
    })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.kind, "goodwill"),
        gte(creditAccountLedgerTable.createdAt, since),
        ...(tenantId !== undefined ? [eq(creditAccountLedgerTable.tenantId, tenantId)] : []),
      ),
    );
  return Number(row?.total ?? 0);
}

async function keysUsed(
  executor: Tx | typeof db,
  tenantId: number,
  prefix: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<string>`COUNT(*)` })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.kind, "goodwill"),
        like(creditAccountLedgerTable.idempotencyKey, `${prefix}%`),
      ),
    );
  return Number(row?.count ?? 0);
}

const smartEditKey = (jobId: number) => `goodwill:smart-edit:${jobId}`;
const imageRedoPrefix = (jobId: number) => `goodwill:image-redo:${jobId}:`;

/** What is still free on one video, for quotes and button labels. */
export interface GoodwillAvailability {
  /** False when goodwill is off or the workspace is not paying in credits. */
  active: boolean;
  imageRedosLeft: number;
  smartEditFreeSeconds: number;
  /** True while the video's one free Smart Edit has not been used. */
  smartEditFreeAvailable: boolean;
  /** Goodwill credits this workspace can still receive this month. */
  monthlyBudgetLeft: number;
}

export async function goodwillAvailability(
  tenantId: number,
  jobId: number,
): Promise<GoodwillAvailability> {
  const settings = await getGoodwillSettings();
  const funded = settings.enabled && (await isCreditFunded(tenantId));
  if (!funded) {
    return {
      active: false,
      imageRedosLeft: 0,
      smartEditFreeSeconds: 0,
      smartEditFreeAvailable: false,
      monthlyBudgetLeft: 0,
    };
  }
  const [redosUsed, smartUsed, monthMilli] = await Promise.all([
    keysUsed(db, tenantId, imageRedoPrefix(jobId)),
    keysUsed(db, tenantId, smartEditKey(jobId)),
    goodwillMilliSince(db, monthStartUtc(new Date()), tenantId),
  ]);
  const budgetLeft = Math.max(0, settings.monthlyBudgetCredits - monthMilli / MILLI);
  return {
    active: true,
    imageRedosLeft: budgetLeft > 0 ? Math.max(0, settings.freeImageRedosPerVideo - redosUsed) : 0,
    smartEditFreeSeconds: settings.freeSmartEditSeconds,
    smartEditFreeAvailable:
      budgetLeft > 0 && settings.freeSmartEditSeconds > 0 && smartUsed === 0,
    monthlyBudgetLeft: Math.round(budgetLeft * 1000) / 1000,
  };
}

export type GoodwillFix =
  | { kind: "smart_edit"; jobId: number }
  | { kind: "image_redo"; jobId: number };

/**
 * Grant the credits for one free fix, or nothing. Returns the credits granted
 * (0 when the fix is not free: goodwill off, not credit-funded, already used
 * on this video, or over the monthly budget). Never throws for a business
 * reason; a database error is logged and treated as "not free", so goodwill
 * can never block a fix the customer is willing to pay for.
 */
export async function claimGoodwill(
  tenantId: number,
  fix: GoodwillFix,
  credits: number,
  note: string,
): Promise<number> {
  if (!(credits > 0)) return 0;
  try {
    const settings = await getGoodwillSettings();
    if (!settings.enabled || !(await isCreditFunded(tenantId))) return 0;
    const granted = await db.transaction(async (tx) => {
      // Serialise goodwill per workspace so two fixes at once cannot both fit
      // under the last of the budget or both take the video's free slot.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${7_340_013}, ${tenantId})`);
      let key: string;
      if (fix.kind === "smart_edit") {
        if (settings.freeSmartEditSeconds <= 0) return 0;
        key = smartEditKey(fix.jobId);
        if ((await keysUsed(tx, tenantId, key)) > 0) return 0;
      } else {
        const used = await keysUsed(tx, tenantId, imageRedoPrefix(fix.jobId));
        if (used >= settings.freeImageRedosPerVideo) return 0;
        key = `${imageRedoPrefix(fix.jobId)}${used + 1}`;
      }
      const monthMilli = await goodwillMilliSince(tx, monthStartUtc(new Date()), tenantId);
      const leftMilli = settings.monthlyBudgetCredits * MILLI - monthMilli;
      const wantMilli = Math.round(credits * MILLI);
      if (leftMilli < wantMilli) return 0;
      await grantCredits(
        {
          tenantId,
          credits: wantMilli / MILLI,
          kind: "goodwill",
          expiresInDays: GOODWILL_EXPIRES_IN_DAYS,
          idempotencyKey: key,
          note,
          refKind: GOODWILL_REF_KIND,
          refId: String(fix.jobId),
        },
        tx,
      );
      return wantMilli / MILLI;
    });
    if (granted > 0) void checkGoodwillAlarm(settings);
    return granted;
  } catch (err) {
    logger.warn({ err, tenantId, fix }, "Goodwill claim failed; the fix is charged normally");
    return 0;
  }
}

/**
 * Fire the daily alarm once per UTC day when platform-wide goodwill crosses
 * the threshold. The date stamp is claimed with a conditional update, so two
 * servers crossing at once alert once.
 */
export async function checkGoodwillAlarm(
  settings?: GoodwillSettings,
  notify: (totalCredits: number, thresholdCredits: number) => Promise<unknown> = defaultNotify,
): Promise<boolean> {
  try {
    const current = settings ?? (await getGoodwillSettings());
    if (current.dailyAlarmCredits <= 0) return false;
    const now = new Date();
    const totalMilli = await goodwillMilliSince(db, dayStartUtc(now));
    if (totalMilli < current.dailyAlarmCredits * MILLI) return false;
    const today = now.toISOString().slice(0, 10);
    await db
      .insert(goodwillSettingsTable)
      .values({ id: SETTINGS_ROW_ID, ...DEFAULT_GOODWILL_SETTINGS, ...current })
      .onConflictDoNothing();
    const claimed = await db
      .update(goodwillSettingsTable)
      .set({ lastAlarmDate: today })
      .where(
        and(
          eq(goodwillSettingsTable.id, SETTINGS_ROW_ID),
          sql`${goodwillSettingsTable.lastAlarmDate} IS DISTINCT FROM ${today}`,
        ),
      )
      .returning({ id: goodwillSettingsTable.id });
    if (claimed.length === 0) return false;
    await notify(totalMilli / MILLI, current.dailyAlarmCredits);
    return true;
  } catch (err) {
    logger.warn({ err }, "Goodwill alarm check failed");
    return false;
  }
}

async function defaultNotify(totalCredits: number, thresholdCredits: number): Promise<void> {
  const { notifyGoodwillAlarm } = await import("./notifications");
  await notifyGoodwillAlarm(totalCredits, thresholdCredits);
}

export interface GoodwillReport {
  todayCredits: number;
  monthCredits: number;
  monthFixes: number;
  topWorkspaces: Array<{ tenantId: number; credits: number; fixes: number }>;
}

/** What goodwill has cost this UTC day and month, for the admin card. */
export async function goodwillReport(): Promise<GoodwillReport> {
  const now = new Date();
  const month = monthStartUtc(now);
  const [todayMilli, monthMilli, rows] = await Promise.all([
    goodwillMilliSince(db, dayStartUtc(now)),
    goodwillMilliSince(db, month),
    db
      .select({
        tenantId: creditAccountLedgerTable.tenantId,
        milli: sql<string>`SUM(${creditAccountLedgerTable.grantedDeltaMilli} + ${creditAccountLedgerTable.purchasedDeltaMilli})`,
        fixes: sql<string>`COUNT(*)`,
      })
      .from(creditAccountLedgerTable)
      .where(
        and(
          eq(creditAccountLedgerTable.kind, "goodwill"),
          gte(creditAccountLedgerTable.createdAt, month),
        ),
      )
      .groupBy(creditAccountLedgerTable.tenantId),
  ]);
  const workspaces = rows
    .map((row) => ({
      tenantId: row.tenantId,
      credits: Number(row.milli) / MILLI,
      fixes: Number(row.fixes),
    }))
    .sort((a, b) => b.credits - a.credits);
  return {
    todayCredits: todayMilli / MILLI,
    monthCredits: monthMilli / MILLI,
    monthFixes: workspaces.reduce((total, w) => total + w.fixes, 0),
    topWorkspaces: workspaces.slice(0, 10),
  };
}

/**
 * The free part of a Smart Edit quote: every frame edit plus the first S
 * seconds of the regenerated clip. New line (dialogue) edits are never free.
 */
export function smartEditFreeCredits(
  type: string,
  quote: { lines: Array<{ rateKey: string; quantity: number; credits: number }> },
  freeSeconds: number,
): { freeCredits: number; freeSeconds: number } {
  if (type === "dialogue" || freeSeconds <= 0) return { freeCredits: 0, freeSeconds: 0 };
  let milli = 0;
  let seconds = 0;
  for (const line of quote.lines) {
    if (line.rateKey === "image_edit") {
      milli += Math.round(line.credits * MILLI);
    } else if ((line.rateKey === "video" || line.rateKey === "video_hd") && line.quantity > 0) {
      seconds = Math.min(freeSeconds, line.quantity);
      milli += Math.round((line.credits * MILLI * seconds) / line.quantity);
    }
  }
  return { freeCredits: milli / MILLI, freeSeconds: seconds };
}

/**
 * A Smart Edit quote with this video's free part taken off. `credits` is what
 * the user will actually pay; `fullCredits` is the whole edit. The free part
 * never exceeds the edit or what is left of the monthly budget.
 */
export function applySmartEditGoodwill<
  Q extends { credits: number; lines: Array<{ rateKey: string; quantity: number; credits: number }> },
>(
  quote: Q,
  type: string,
  availability: Pick<GoodwillAvailability, "smartEditFreeAvailable" | "smartEditFreeSeconds" | "monthlyBudgetLeft">,
): Q & { fullCredits: number; freeCredits: number; freeSeconds: number } {
  const free = availability.smartEditFreeAvailable
    ? smartEditFreeCredits(type, quote, availability.smartEditFreeSeconds)
    : { freeCredits: 0, freeSeconds: 0 };
  const freeCredits = Math.min(free.freeCredits, quote.credits, availability.monthlyBudgetLeft);
  return {
    ...quote,
    fullCredits: quote.credits,
    credits: Math.round((quote.credits - freeCredits) * 1000) / 1000,
    freeCredits,
    freeSeconds: freeCredits > 0 ? free.freeSeconds : 0,
  };
}
