import {
  adminAuditLogsTable,
  creditMeterSettingsTable,
  creditRatesTable,
  db,
  planSettingsTable,
  tenantsTable,
} from "@workspace/db";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invalidateCreditRateCache,
  REQUIRED_CREDIT_RATE_KEYS,
  validateCreditRateCard,
  type CreditRateUnit,
  type ReplaceCreditRateCardInput,
} from "./creditRates";
import {
  isProductionCreditEnforcementEnabled,
  PRODUCTION_CREDIT_ROLLOUT_MANIFEST_SETTING,
  PRODUCTION_CREDIT_ENFORCEMENT_VERSION,
} from "./creditReconciliationGate";

/**
 * The production rollout is deliberately data-only. It does not create a
 * schema object, an account, a balance, a ledger row, a usage row, a wallet
 * conversion, or a grant. The only tenant mutation is the explicit billing
 * rail switch for tenants on a plan named in the reviewed manifest.
 */

export const CREDIT_PRODUCTION_ROLLOUT_JSON =
  PRODUCTION_CREDIT_ROLLOUT_MANIFEST_SETTING;
export const PRODUCTION_CREDIT_ROLLOUT_LOCK_NAME =
  "kokao:production-credit-rollout";
export const PRODUCTION_CREDIT_ROLLOUT_AUDIT_ACTION = "credit_rates_change";

type RolloutVersion = typeof PRODUCTION_CREDIT_ENFORCEMENT_VERSION;

export interface ProductionCreditRateManifestEntry {
  key: string;
  label: string;
  unit: CreditRateUnit;
  credits: number;
  active: boolean;
  sortOrder: number;
  notes: string | null;
}

export interface ProductionCreditPlanManifestEntry {
  id: string;
  billingMode: "credits";
  monthlyCredits: number;
}

/**
 * Exact shape of CREDIT_PRODUCTION_ROLLOUT_JSON. Values are intentionally not
 * supplied by the application: the deployment owner must provide the reviewed
 * card and plan allowances.
 */
export interface ProductionCreditRolloutManifest {
  rolloutVersion: RolloutVersion;
  mode: "enforce";
  creditPricePaise: number;
  rates: ReadonlyArray<ProductionCreditRateManifestEntry>;
  plans: ReadonlyArray<ProductionCreditPlanManifestEntry>;
}

export interface ProductionCreditBootstrapResult {
  status: "skipped" | "applied" | "already-applied";
  rolloutVersion?: RolloutVersion;
  updatedPlanIds?: string[];
  updatedTenantCount?: number;
}

export class ProductionCreditRolloutValidationError extends Error {
  readonly code = "PRODUCTION_CREDIT_ROLLOUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProductionCreditRolloutValidationError";
  }
}

export class ProductionCreditRolloutConflictError extends Error {
  readonly code = "PRODUCTION_CREDIT_ROLLOUT_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ProductionCreditRolloutConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  path: string,
): void {
  const expected = new Set(required);
  const actual = Object.keys(value);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = actual.filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new ProductionCreditRolloutValidationError(
      `${path} must contain exactly the reviewed fields` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""),
    );
  }
}

function assertNonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProductionCreditRolloutValidationError(
      `${path} must be a non-negative safe integer`,
    );
  }
  return Number(value);
}

function assertPositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ProductionCreditRolloutValidationError(
      `${path} must be a positive safe integer`,
    );
  }
  return Number(value);
}

function parseRate(
  value: unknown,
  index: number,
): ProductionCreditRateManifestEntry {
  const path = `rates[${index}]`;
  if (!isRecord(value)) {
    throw new ProductionCreditRolloutValidationError(`${path} must be an object`);
  }
  assertExactKeys(
    value,
    ["key", "label", "unit", "credits", "active", "sortOrder", "notes"],
    path,
  );
  if (
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    (value.unit !== "item" && value.unit !== "second") ||
    typeof value.credits !== "number" ||
    !Number.isFinite(value.credits) ||
    value.credits < 0 ||
    typeof value.active !== "boolean" ||
    typeof value.notes !== "string" && value.notes !== null
  ) {
    throw new ProductionCreditRolloutValidationError(
      `${path} contains an invalid reviewed rate`,
    );
  }
  if (value.credits > 0 && Math.round(value.credits * 1000) === 0) {
    throw new ProductionCreditRolloutValidationError(
      `${path}.credits must be 0 or at least 0.001`,
    );
  }
  return {
    key: value.key,
    label: value.label,
    unit: value.unit,
    credits: value.credits,
    active: value.active,
    sortOrder: assertNonNegativeSafeInteger(value.sortOrder, `${path}.sortOrder`),
    notes: value.notes,
  };
}

function parsePlan(
  value: unknown,
  index: number,
): ProductionCreditPlanManifestEntry {
  const path = `plans[${index}]`;
  if (!isRecord(value)) {
    throw new ProductionCreditRolloutValidationError(`${path} must be an object`);
  }
  assertExactKeys(value, ["id", "billingMode", "monthlyCredits"], path);
  if (
    typeof value.id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(value.id) ||
    value.billingMode !== "credits"
  ) {
    throw new ProductionCreditRolloutValidationError(
      `${path} must name a plan and set billingMode to credits`,
    );
  }
  return {
    id: value.id,
    billingMode: "credits",
    monthlyCredits: assertNonNegativeSafeInteger(
      value.monthlyCredits,
      `${path}.monthlyCredits`,
    ),
  };
}

/**
 * Parse and validate the deployment manifest without consulting the database.
 * The strict key checks prevent a copied or partially reviewed card from
 * silently becoming a production pricing decision.
 */
export function parseProductionCreditRolloutManifest(
  raw: string,
): ProductionCreditRolloutManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProductionCreditRolloutValidationError(
      `${CREDIT_PRODUCTION_ROLLOUT_JSON} must contain valid JSON`,
    );
  }
  if (!isRecord(value)) {
    throw new ProductionCreditRolloutValidationError(
      `${CREDIT_PRODUCTION_ROLLOUT_JSON} must contain a JSON object`,
    );
  }
  assertExactKeys(
    value,
    [
      "rolloutVersion",
      "mode",
      "creditPricePaise",
      "rates",
      "plans",
    ],
    "rollout",
  );
  if (value.rolloutVersion !== PRODUCTION_CREDIT_ENFORCEMENT_VERSION) {
    throw new ProductionCreditRolloutValidationError(
      `rollout.rolloutVersion must be ${PRODUCTION_CREDIT_ENFORCEMENT_VERSION}`,
    );
  }
  if (value.mode !== "enforce") {
    throw new ProductionCreditRolloutValidationError(
      "rollout.mode must be enforce",
    );
  }
  const creditPricePaise = assertPositiveSafeInteger(
    value.creditPricePaise,
    "rollout.creditPricePaise",
  );
  if (
    !Array.isArray(value.rates) ||
    value.rates.length === 0
  ) {
    throw new ProductionCreditRolloutValidationError(
      "rollout.rates must be a non-empty reviewed card",
    );
  }
  if (!Array.isArray(value.plans) || value.plans.length === 0) {
    throw new ProductionCreditRolloutValidationError(
      "rollout.plans must be a non-empty reviewed plan list",
    );
  }
  const rates = value.rates.map(parseRate);
  const rateKeys = rates.map((rate) => rate.key);
  if (
    new Set(rateKeys).size !== rateKeys.length ||
    REQUIRED_CREDIT_RATE_KEYS.some((key) => !rateKeys.includes(key)) ||
    rateKeys.some((key) => !REQUIRED_CREDIT_RATE_KEYS.includes(key))
  ) {
    throw new ProductionCreditRolloutValidationError(
      `rollout.rates must contain exactly these reviewed keys: ${REQUIRED_CREDIT_RATE_KEYS.join(", ")}`,
    );
  }
  const plans = value.plans.map(parsePlan);
  const planIds = plans.map((plan) => plan.id);
  if (new Set(planIds).size !== planIds.length) {
    throw new ProductionCreditRolloutValidationError(
      "rollout.plans must not contain duplicate plan ids",
    );
  }
  const card: ReplaceCreditRateCardInput = {
    mode: "enforce",
    creditPricePaise,
    rates,
  };
  try {
    validateCreditRateCard(card);
  } catch (error) {
    throw new ProductionCreditRolloutValidationError(
      `rollout.rates is not enforceable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    rolloutVersion: PRODUCTION_CREDIT_ENFORCEMENT_VERSION,
    mode: "enforce",
    creditPricePaise,
    rates,
    plans,
  };
}

export interface NormalizedProductionCreditRolloutManifest {
  rolloutVersion: RolloutVersion;
  mode: "enforce";
  creditPricePaise: number;
  rates: ReadonlyArray<ProductionCreditRateManifestEntry>;
  plans: ReadonlyArray<ProductionCreditPlanManifestEntry>;
}

/**
 * Canonicalize the reviewed values before hashing. Array order is not a
 * pricing decision, so sorting rates/plans prevents harmless JSON reordering
 * from looking like a second rollout while every reviewed value remains part
 * of the digest.
 */
export function normalizeProductionCreditRolloutManifest(
  manifest: ProductionCreditRolloutManifest,
): NormalizedProductionCreditRolloutManifest {
  return {
    rolloutVersion: manifest.rolloutVersion,
    mode: manifest.mode,
    creditPricePaise: manifest.creditPricePaise,
    rates: [...manifest.rates]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((rate) => ({ ...rate })),
    plans: [...manifest.plans]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((plan) => ({ ...plan })),
  };
}

export function productionCreditRolloutManifestDigest(
  manifest: ProductionCreditRolloutManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeProductionCreditRolloutManifest(manifest)))
    .digest("hex");
}

interface ProductionCreditRolloutMarker {
  rolloutVersion: string;
  manifestDigest: string | null;
}

function markerFromAudit(value: string | null): ProductionCreditRolloutMarker | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.marker !== "production_saved_rate_activation" ||
      typeof parsed.rolloutVersion !== "string"
    ) {
      return null;
    }
    return {
      rolloutVersion: parsed.rolloutVersion,
      manifestDigest:
        typeof parsed.manifestDigest === "string"
          ? parsed.manifestDigest
          : null,
    };
  } catch {
    return null;
  }
}

function manifestToRateValues(
  rates: ReadonlyArray<ProductionCreditRateManifestEntry>,
) {
  return rates.map((rate) => ({
    key: rate.key,
    label: rate.label,
    unit: rate.unit,
    creditsMilli: Math.round(rate.credits * 1000),
    active: rate.active,
    sortOrder: rate.sortOrder,
    notes: rate.notes,
  }));
}

export interface InitializeProductionCreditBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  database?: typeof db;
  /** Test seam for already parsed fixtures; deployment uses the env var. */
  manifest?: ProductionCreditRolloutManifest;
}

/**
 * Apply the reviewed production data bootstrap before the HTTP server starts.
 *
 * The advisory lock is transaction-scoped, so two deployment replicas cannot
 * both observe an empty card and write duplicate data. The marker is inserted
 * last in the same transaction; after it exists, later boots intentionally do
 * not reconcile or reset admin changes.
 */
export async function initializeProductionCreditBootstrap(
  options: InitializeProductionCreditBootstrapOptions = {},
): Promise<ProductionCreditBootstrapResult> {
  const env = options.env ?? process.env;
  if (!isProductionCreditEnforcementEnabled(env)) {
    return { status: "skipped" };
  }
  const manifest = parseProductionCreditRolloutManifest(
    options.manifest
      ? JSON.stringify(options.manifest)
      : env[CREDIT_PRODUCTION_ROLLOUT_JSON] ?? "",
  );
  const database = options.database ?? db;
  const planIds = manifest.plans.map((plan) => plan.id);
  const manifestDigest = productionCreditRolloutManifestDigest(manifest);
  const normalizedManifest = normalizeProductionCreditRolloutManifest(manifest);
  const now = new Date();

  const result = await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${PRODUCTION_CREDIT_ROLLOUT_LOCK_NAME}))`,
    );

    const markers = await tx
      .select({ newValue: adminAuditLogsTable.newValue })
      .from(adminAuditLogsTable)
      .where(eq(adminAuditLogsTable.action, PRODUCTION_CREDIT_ROLLOUT_AUDIT_ACTION));
    const rolloutMarkers = markers
      .map((marker) => markerFromAudit(marker.newValue))
      .filter((marker): marker is ProductionCreditRolloutMarker => marker !== null);
    const sameVersionMarker = rolloutMarkers.find(
      (marker) => marker.rolloutVersion === manifest.rolloutVersion,
    );
    if (sameVersionMarker) {
      if (sameVersionMarker.manifestDigest !== manifestDigest) {
        throw new ProductionCreditRolloutConflictError(
          "The saved production rollout version exists with a different reviewed manifest digest; refusing to reset it.",
        );
      }
      return {
        status: "already-applied" as const,
        rolloutVersion: manifest.rolloutVersion,
      };
    }
    if (rolloutMarkers.length > 0) {
      throw new ProductionCreditRolloutConflictError(
        `A different production credit rollout is already recorded (${rolloutMarkers
          .map((marker) => marker.rolloutVersion)
          .join(", ")}).`,
      );
    }

    const existingSettings = await tx
      .select({ id: creditMeterSettingsTable.id })
      .from(creditMeterSettingsTable);
    if (existingSettings.length > 0) {
      throw new ProductionCreditRolloutConflictError(
        "credit_meter_settings is not empty and has no reviewed rollout marker; refusing to overwrite it.",
      );
    }
    const existingRates = await tx
      .select({ id: creditRatesTable.id })
      .from(creditRatesTable);
    if (existingRates.length > 0) {
      throw new ProductionCreditRolloutConflictError(
        "credit_rates is not empty and has no reviewed rollout marker; refusing to overwrite it.",
      );
    }

    const productionPlanRows = await tx
      .select({ id: planSettingsTable.id })
      .from(planSettingsTable);
    const assignedTenantPlans = await tx
      .select({ plan: tenantsTable.plan })
      .from(tenantsTable);
    const requiredPlanIds = new Set([
      ...productionPlanRows.map((plan) => plan.id),
      ...assignedTenantPlans.map((tenant) => tenant.plan),
    ]);
    const reviewedPlanIds = new Set(planIds);
    const omittedPlans = [...requiredPlanIds].filter(
      (id) => !reviewedPlanIds.has(id),
    );
    const unknownPlans = planIds.filter((id) => !requiredPlanIds.has(id));
    if (omittedPlans.length > 0 || unknownPlans.length > 0) {
      throw new ProductionCreditRolloutConflictError(
        `Reviewed production rollout plan ids must exactly match production rows and assigned tenants;` +
          (omittedPlans.length > 0
            ? ` omitted: ${omittedPlans.join(", ")};`
            : "") +
          (unknownPlans.length > 0
            ? ` missing production rows/tenants: ${unknownPlans.join(", ")}`
            : ""),
      );
    }
    const missingPlanRows = planIds.filter(
      (id) => !productionPlanRows.some((plan) => plan.id === id),
    );
    if (missingPlanRows.length > 0) {
      throw new ProductionCreditRolloutConflictError(
        `Reviewed production rollout names plan ids without plan rows: ${missingPlanRows.join(", ")}`,
      );
    }

    await tx
      .insert(creditMeterSettingsTable)
      .values({
        id: 1,
        mode: "enforce",
        creditPricePaise: manifest.creditPricePaise,
      });
    await tx.insert(creditRatesTable).values(manifestToRateValues(manifest.rates));

    for (const plan of manifest.plans) {
      await tx
        .update(planSettingsTable)
        .set({
          billingMode: plan.billingMode,
          monthlyCredits: plan.monthlyCredits,
          updatedAt: now,
        })
        .where(eq(planSettingsTable.id, plan.id));
    }

    const updatedTenants = await tx
      .update(tenantsTable)
      .set({ billingMode: "credits", updatedAt: now })
      .where(and(inArray(tenantsTable.plan, planIds)))
      .returning({ id: tenantsTable.id });

    await tx.insert(adminAuditLogsTable).values({
      action: PRODUCTION_CREDIT_ROLLOUT_AUDIT_ACTION,
      // 0 is the non-tenant deployment operator identity. This is not an
      // impersonated customer/admin actor; the trusted deployment environment
      // is the authorization boundary for this startup-only mutation.
      actorTenantId: 0,
      actorEmail: "deployment-owner",
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify({
        rolloutVersion: manifest.rolloutVersion,
        settings: "empty",
        rates: "empty",
        tenantBillingMode: "named-plan-tenants",
      }),
      newValue: JSON.stringify({
        rolloutVersion: manifest.rolloutVersion,
        marker: "production_saved_rate_activation",
        manifestDigest,
        normalizedManifest,
        principal: "deployment-owner",
        authorization: "user-approved trusted deployment environment",
        mode: "enforce",
        planIds,
        tenantBillingMode: "credits",
        invoicesVerified: false,
        creditAccountsChanged: false,
        balancesChanged: false,
        walletsChanged: false,
        usageHistoryChanged: false,
        ledgerChanged: false,
        grantsCreated: false,
        legacyJobsChanged: false,
      }),
    });

    return {
      status: "applied" as const,
      rolloutVersion: manifest.rolloutVersion,
      updatedPlanIds: planIds,
      updatedTenantCount: updatedTenants.length,
    };
  });

  if (result.status === "applied") {
    invalidateCreditRateCache();
  }
  return result;
}

/** Short alias for callers that describe this as a bootstrap. */
export const bootstrapProductionCredits = initializeProductionCreditBootstrap;
export const bootstrapProductionCreditRollout =
  initializeProductionCreditBootstrap;
export const initializeProductionCreditRollout =
  initializeProductionCreditBootstrap;
