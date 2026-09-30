import {
  db,
  creatorAccountsTable,
  creatorAttributionsTable,
  creatorCodesTable,
  creatorProgramSettingsTable,
  referralAttributionsTable,
  tenantsTable,
  type CreatorAccount,
  type CreatorCode,
  type CreatorProgramSettings,
} from "@workspace/db";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { generatePromoCode, normalizePromoCode } from "./promoCodes";

/**
 * Program B — creator lifecycle, code issuance and attribution.
 *
 * A creator applies, an admin approves, and only then is a code issued. PAN
 * and bank details are NOT collected here — they are a payout-time concern
 * (see creator_payout_identities), because nobody should hand over a PAN to
 * get a link.
 *
 * Accrual, risk scoring and maturation live in ./creatorCommissions.
 */

export type CreatorStatus =
  | "applied"
  | "approved"
  | "rejected"
  | "suspended"
  | "closed";

export const CREATOR_AGREEMENT_VERSION = "2026-09-v1";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CommissionSlab {
  minReferrals: number;
  commissionBps: number;
}

export const DEFAULT_COMMISSION_SLABS: ReadonlyArray<CommissionSlab> = [
  { minReferrals: 0, commissionBps: 1000 },
  { minReferrals: 5, commissionBps: 1200 },
  { minReferrals: 15, commissionBps: 1500 },
];

/** The singleton settings row, seeded on first read. */
export async function getCreatorProgramSettings(): Promise<CreatorProgramSettings> {
  const [row] = await db.select().from(creatorProgramSettingsTable).limit(1);
  if (row) return row;
  // The unique index on `singleton` makes this a hard DB-level singleton:
  // concurrent first calls collide and one seeds the row, the rest no-op.
  await db
    .insert(creatorProgramSettingsTable)
    .values({})
    .onConflictDoNothing();
  const [seeded] = await db.select().from(creatorProgramSettingsTable).limit(1);
  return seeded!;
}

export async function updateCreatorProgramSettings(
  changes: Partial<CreatorProgramSettings>,
): Promise<CreatorProgramSettings> {
  const current = await getCreatorProgramSettings();
  const { id: _id, singleton: _s, updatedAt: _u, ...safe } = changes;
  const [updated] = await db
    .update(creatorProgramSettingsTable)
    .set(safe)
    .where(eq(creatorProgramSettingsTable.id, current.id))
    .returning();
  return updated!;
}

export function commissionSlabsFrom(
  settings: CreatorProgramSettings,
): CommissionSlab[] {
  const raw = settings.commissionSlabs;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_COMMISSION_SLABS];
  }
  return raw
    .filter(
      (s): s is CommissionSlab =>
        !!s &&
        Number.isFinite(s.minReferrals) &&
        Number.isFinite(s.commissionBps),
    )
    .map((s) => ({
      minReferrals: Math.max(0, Math.floor(s.minReferrals)),
      commissionBps: Math.max(0, Math.min(10_000, Math.floor(s.commissionBps))),
    }))
    .sort((a, b) => a.minReferrals - b.minReferrals);
}

/** Highest rung the count reaches; falls back to the first. */
export function pickCommissionSlab(
  slabs: CommissionSlab[],
  qualifyingCount: number,
): { slab: CommissionSlab; index: number } {
  let index = 0;
  for (let i = 0; i < slabs.length; i++) {
    if (qualifyingCount >= slabs[i]!.minReferrals) index = i;
  }
  return { slab: slabs[index]!, index };
}

// ---------------------------------------------------------------------------
// Application and approval
// ---------------------------------------------------------------------------

export class CreatorProgramError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "program_disabled"
      | "duplicate_application"
      | "not_found"
      | "bad_state"
      | "no_active_code",
  ) {
    super(message);
    this.name = "CreatorProgramError";
  }
}

export interface CreatorApplication {
  /**
   * The applicant's KOKAO workspace. Required — a promoter signs up for KOKAO
   * and applies from inside the product, so the session already identifies
   * them and there is no separate creator login to build.
   */
  tenantId: number;
  displayName: string;
  /** Defaults to the workspace's own email when omitted. */
  contactEmail?: string;
  phone?: string | null;
  channels?: {
    platform: string;
    handle: string;
    url?: string;
    followers?: number;
  }[];
  vertical?: string | null;
  isRegisteredPractitioner?: boolean;
  agreementAccepted: boolean;
}

/** The promoter account for a workspace, if it has one. */
export async function getCreatorForTenant(
  tenantId: number,
): Promise<CreatorAccount | null> {
  const [row] = await db
    .select()
    .from(creatorAccountsTable)
    .where(eq(creatorAccountsTable.tenantId, tenantId))
    .limit(1);
  return row ?? null;
}

/**
 * Submit an application from a signed-in workspace. Auto-approves (and issues a
 * code) when the admin has turned that on; otherwise it lands in the review
 * queue.
 */
export async function applyAsCreator(
  input: CreatorApplication,
): Promise<{ creator: CreatorAccount; code: CreatorCode | null }> {
  const settings = await getCreatorProgramSettings();
  if (!settings.programEnabled) {
    throw new CreatorProgramError(
      "The creator program is not open right now.",
      "program_disabled",
    );
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, input.tenantId))
    .limit(1);
  if (!tenant) {
    throw new CreatorProgramError("Workspace not found.", "not_found");
  }

  const existing = await getCreatorForTenant(input.tenantId);
  if (existing) {
    throw new CreatorProgramError(
      "This workspace has already applied to the promoter program.",
      "duplicate_application",
    );
  }

  const email = (input.contactEmail ?? tenant.email ?? "")
    .trim()
    .toLowerCase();
  if (!email) {
    throw new CreatorProgramError(
      "A contact email is required to apply.",
      "bad_state",
    );
  }
  const [emailTaken] = await db
    .select({ id: creatorAccountsTable.id })
    .from(creatorAccountsTable)
    .where(eq(creatorAccountsTable.contactEmail, email))
    .limit(1);
  if (emailTaken) {
    throw new CreatorProgramError(
      "An application already exists for this email.",
      "duplicate_application",
    );
  }

  const autoApprove = settings.autoApproveCreators;
  const [creator] = await db
    .insert(creatorAccountsTable)
    .values({
      tenantId: input.tenantId,
      status: autoApprove ? "approved" : "applied",
      displayName: input.displayName.trim(),
      contactEmail: email,
      phone: input.phone ?? null,
      channels: input.channels ?? [],
      vertical: input.vertical ?? null,
      isRegisteredPractitioner: input.isRegisteredPractitioner ?? false,
      agreementVersion: input.agreementAccepted
        ? CREATOR_AGREEMENT_VERSION
        : null,
      agreementAcceptedAt: input.agreementAccepted ? new Date() : null,
      reviewedAt: autoApprove ? new Date() : null,
    })
    .returning();

  const code = autoApprove ? await issueCreatorCode(creator!.id) : null;
  return { creator: creator!, code };
}

export async function reviewCreator(
  creatorId: number,
  decision: "approved" | "rejected",
  reviewerTenantId: number,
  reason?: string,
): Promise<{ creator: CreatorAccount; code: CreatorCode | null }> {
  const [creator] = await db
    .select()
    .from(creatorAccountsTable)
    .where(eq(creatorAccountsTable.id, creatorId))
    .limit(1);
  if (!creator) {
    throw new CreatorProgramError("Creator not found.", "not_found");
  }
  if (creator.status !== "applied") {
    throw new CreatorProgramError(
      `Cannot review a creator in state "${creator.status}".`,
      "bad_state",
    );
  }

  const [updated] = await db
    .update(creatorAccountsTable)
    .set({
      status: decision,
      reviewedByTenantId: reviewerTenantId,
      reviewedAt: new Date(),
      statusReason: reason ?? null,
    })
    .where(eq(creatorAccountsTable.id, creatorId))
    .returning();

  const code =
    decision === "approved" ? await issueCreatorCode(creatorId) : null;
  return { creator: updated!, code };
}

/**
 * Suspend or restore a creator. Suspension deactivates their codes so nothing
 * new attaches; it deliberately does NOT touch commissions already accrued —
 * what happens to pending earnings is an explicit admin decision, not a side
 * effect of flipping a status.
 */
export async function setCreatorStatus(
  creatorId: number,
  status: Extract<CreatorStatus, "approved" | "suspended" | "closed">,
  reviewerTenantId: number,
  reason?: string,
): Promise<CreatorAccount> {
  const [updated] = await db
    .update(creatorAccountsTable)
    .set({
      status,
      reviewedByTenantId: reviewerTenantId,
      reviewedAt: new Date(),
      statusReason: reason ?? null,
    })
    .where(eq(creatorAccountsTable.id, creatorId))
    .returning();
  if (!updated) {
    throw new CreatorProgramError("Creator not found.", "not_found");
  }
  if (status !== "approved") {
    await db
      .update(creatorCodesTable)
      .set({ active: false })
      .where(eq(creatorCodesTable.creatorId, creatorId));
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/** Mint a code for an approved creator. Retries on the astronomical collision. */
export async function issueCreatorCode(
  creatorId: number,
  options: {
    label?: string;
    reusePolicy?: "single_use" | "multi_use";
    maxRedemptions?: number | null;
    expiresAt?: Date | null;
  } = {},
): Promise<CreatorCode> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [created] = await db
        .insert(creatorCodesTable)
        .values({
          creatorId,
          code: generatePromoCode("KC", 8),
          label: options.label ?? null,
          reusePolicy: options.reusePolicy ?? "multi_use",
          maxRedemptions:
            options.reusePolicy === "single_use"
              ? 1
              : (options.maxRedemptions ?? null),
          expiresAt: options.expiresAt ?? null,
          active: true,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("Could not mint a creator code");
}

export async function listCreatorCodes(
  creatorId: number,
): Promise<CreatorCode[]> {
  return db
    .select()
    .from(creatorCodesTable)
    .where(eq(creatorCodesTable.creatorId, creatorId))
    .orderBy(desc(creatorCodesTable.createdAt));
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export type CreatorAttachFailure =
  | "invalid_code"
  | "inactive"
  | "not_started"
  | "expired"
  | "limit_reached"
  | "creator_not_approved"
  | "already_attributed"
  | "own_code"
  | "program_disabled";

export type CreatorAttachResult =
  | { ok: true; code: CreatorCode; creator: CreatorAccount }
  | { ok: false; reason: CreatorAttachFailure; message: string };

function attachFailureMessage(reason: CreatorAttachFailure): string {
  switch (reason) {
    case "invalid_code":
      return "That code is not valid. Check the spelling and try again.";
    case "inactive":
      return "This code is no longer active.";
    case "not_started":
      return "This code is not active yet.";
    case "expired":
      return "This code has expired.";
    case "limit_reached":
      return "This code has reached its maximum number of uses.";
    case "creator_not_approved":
      return "This code is not currently active.";
    case "already_attributed":
      return "Your workspace already has a referral or creator code applied.";
    case "own_code":
      return "You can't use your own creator code.";
    case "program_disabled":
      return "Creator codes are currently disabled.";
  }
}

/**
 * Attach a creator code to a workspace. Grants nothing — the buyer's bonus and
 * the creator's commission both happen on purchase.
 *
 * Cross-checks `referral_attributions` so a workspace can never carry both a
 * user-referral and a creator attribution; otherwise one purchase would pay
 * twice.
 */
export async function attachCreatorCode(
  tenantId: number,
  rawCode: string,
): Promise<CreatorAttachResult> {
  const settings = await getCreatorProgramSettings();
  if (!settings.programEnabled) {
    return {
      ok: false,
      reason: "program_disabled",
      message: attachFailureMessage("program_disabled"),
    };
  }

  const code = normalizePromoCode(rawCode);
  return db.transaction(async (tx): Promise<CreatorAttachResult> => {
    const [row] = await tx
      .select()
      .from(creatorCodesTable)
      .where(eq(creatorCodesTable.code, code))
      .for("update");
    if (!row) {
      return {
        ok: false,
        reason: "invalid_code",
        message: attachFailureMessage("invalid_code"),
      };
    }

    const now = new Date();
    if (!row.active) {
      return {
        ok: false,
        reason: "inactive",
        message: attachFailureMessage("inactive"),
      };
    }
    if (row.startsAt && row.startsAt > now) {
      return {
        ok: false,
        reason: "not_started",
        message: attachFailureMessage("not_started"),
      };
    }
    if (row.expiresAt && row.expiresAt <= now) {
      return {
        ok: false,
        reason: "expired",
        message: attachFailureMessage("expired"),
      };
    }
    if (
      row.maxRedemptions !== null &&
      row.redemptionCount >= row.maxRedemptions
    ) {
      return {
        ok: false,
        reason: "limit_reached",
        message: attachFailureMessage("limit_reached"),
      };
    }

    const [creator] = await tx
      .select()
      .from(creatorAccountsTable)
      .where(eq(creatorAccountsTable.id, row.creatorId))
      .limit(1);
    if (!creator || creator.status !== "approved") {
      return {
        ok: false,
        reason: "creator_not_approved",
        message: attachFailureMessage("creator_not_approved"),
      };
    }
    // Promoters are KOKAO users, so this check always has something to bite on.
    if (creator.tenantId === tenantId) {
      return {
        ok: false,
        reason: "own_code",
        message: attachFailureMessage("own_code"),
      };
    }

    // One attribution per workspace, across BOTH programs.
    const [existingCreator] = await tx
      .select({ tenantId: creatorAttributionsTable.tenantId })
      .from(creatorAttributionsTable)
      .where(eq(creatorAttributionsTable.tenantId, tenantId))
      .limit(1);
    const [existingReferral] = await tx
      .select({ tenantId: referralAttributionsTable.tenantId })
      .from(referralAttributionsTable)
      .where(
        and(
          eq(referralAttributionsTable.tenantId, tenantId),
          or(
            isNull(referralAttributionsTable.expiresAt),
            gt(referralAttributionsTable.expiresAt, now),
          ),
        ),
      )
      .limit(1);
    if (existingCreator || existingReferral) {
      return {
        ok: false,
        reason: "already_attributed",
        message: attachFailureMessage("already_attributed"),
      };
    }

    const [tenant] = await tx
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);

    await tx.insert(creatorAttributionsTable).values({
      tenantId,
      creatorId: creator.id,
      creatorCodeId: row.id,
      code: row.code,
      expiresAt: new Date(
        now.getTime() + settings.attributionDays * 24 * 60 * 60 * 1000,
      ),
      attachSignals: {
        // Cheap signals captured at attach; the commission risk score reads
        // them later. Gateway instrument fingerprints are NOT available here —
        // see SETUP.md for the follow-up that adds them.
        tenantAgeMinutes: tenant
          ? Math.floor((now.getTime() - tenant.createdAt.getTime()) / 60_000)
          : null,
        tenantEmailDomain: tenant?.email?.split("@")[1]?.toLowerCase() ?? null,
        creatorEmailDomain: creator.contactEmail.split("@")[1]?.toLowerCase(),
        attachedAt: now.toISOString(),
      },
    });

    await tx
      .update(creatorCodesTable)
      .set({ redemptionCount: row.redemptionCount + 1, updatedAt: now })
      .where(eq(creatorCodesTable.id, row.id));

    return { ok: true, code: row, creator };
  });
}

/** The live creator attribution for a workspace, or null. */
export async function getActiveCreatorAttribution(tenantId: number) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(creatorAttributionsTable)
    .where(
      and(
        eq(creatorAttributionsTable.tenantId, tenantId),
        or(
          isNull(creatorAttributionsTable.expiresAt),
          gt(creatorAttributionsTable.expiresAt, now),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Admin listing
// ---------------------------------------------------------------------------

export async function listCreators(
  status?: CreatorStatus,
  limit = 100,
): Promise<CreatorAccount[]> {
  const q = db.select().from(creatorAccountsTable);
  const rows = status
    ? await q
        .where(eq(creatorAccountsTable.status, status))
        .orderBy(desc(creatorAccountsTable.appliedAt))
        .limit(limit)
    : await q.orderBy(desc(creatorAccountsTable.appliedAt)).limit(limit);
  return rows;
}

export async function countAttributedWorkspaces(
  creatorId: number,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creatorAttributionsTable)
    .where(eq(creatorAttributionsTable.creatorId, creatorId));
  return row?.count ?? 0;
}
