import {
  db,
  adsSettingsTable,
  adAccountConnectionsTable,
  adChangeRequestsTable,
  adsChangeLogsTable,
  type AdAccountConnection,
  type AdChangeRequest,
  type AdChangeField,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import { isMetaAppConfigured } from "./metaApi";
import {
  MetaAdsApiError,
  createCampaign,
  getCampaign,
  readObjectState,
  updateObject,
  type AdsTargetType,
  type MetaAdsCredentials,
} from "./metaAdsApi";
import {
  TiktokAdsApiError,
  isTiktokAppConfigured,
  createCampaign as createTiktokCampaign,
  updateCampaign as updateTiktokCampaign,
  updateAdGroup as updateTiktokAdGroup,
  updateAd as updateTiktokAd,
  readCampaignState as readTiktokCampaignState,
  readAdGroupState as readTiktokAdGroupState,
  readAdState as readTiktokAdState,
  type TiktokAdsCredentials,
} from "./tiktokAdsApi";
import {
  LinkedinAdsApiError,
  createLinkedinCampaign,
  createLinkedinCampaignGroup,
  updateLinkedinCampaign,
  updateLinkedinCampaignGroup,
  readLinkedinCampaignState,
  readLinkedinCampaignGroupState,
  type LinkedinAdsCredentials,
  readLinkedinCreativeState,
  getLinkedinAdAccountReference,
  uploadLinkedinAdImage,
  createLinkedinAdPost,
  createLinkedinCreative,
} from "./linkedinAdsApi";
import { ObjectStorageService } from "./objectStorage";
import { isLinkedinAppConfigured } from "./linkedinApp";
import {
  GoogleAdsApiError,
  getGoogleAdsAuth,
  isGoogleAdsConfigured,
  readGoogleCampaignState,
  updateGoogleCampaign,
  createGoogleCampaign,
  readGoogleAdGroupState,
  updateGoogleAdGroup,
  readGoogleAdState,
  updateGoogleAd,
} from "./googleAdsApi";
import {
  maybeRefreshLinkedinAdsToken,
  handleLinkedinAdsAuthFailure,
} from "./linkedinAdsRefresh";
import { tryAcquireResendLock } from "./resendLock";
import { notifyAdsChangeApplied, notifyAdsChangeFailed } from "./notifications";
import { logger } from "./logger";

/**
 * Shared draft-and-approve pipeline for the paid-media module.
 *
 * Safety model:
 * - Every write is first captured as a DRAFT with a human-readable
 *   before/after diff and a snapshot of the remote object's current state.
 * - Nothing touches the ad platform until the workspace OWNER approves.
 * - Apply is idempotent: the draft row's status is claimed atomically
 *   (draft → approved via a status-guarded UPDATE), an in-process lock stops
 *   truly simultaneous requests, and a unique idempotency key blocks
 *   duplicate drafts from retried creations.
 * - At apply time the remote state is re-read and compared with the draft's
 *   snapshot; if the object changed since the draft was made, the draft
 *   EXPIRES instead of applying a stale change.
 * - After the platform write, remote state is read back and verified to
 *   match; every outcome lands in the append-only change log.
 */

// ---------------------------------------------------------------------------
// Module settings (global switch) and platform availability
// ---------------------------------------------------------------------------

export async function getAdsModuleEnabled(): Promise<boolean> {
  const row = (await db.select().from(adsSettingsTable).limit(1))[0];
  return row ? row.enabled : true;
}

export async function setAdsModuleEnabled(enabled: boolean): Promise<void> {
  const row = (await db.select().from(adsSettingsTable).limit(1))[0];
  if (row) {
    await db
      .update(adsSettingsTable)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(adsSettingsTable.id, row.id));
  } else {
    await db.insert(adsSettingsTable).values({ enabled });
  }
}

export interface AdsPlatformAvailability {
  platform: string;
  available: boolean;
  reason: string | null;
}

/** Platforms the ads module knows about; Meta, Google, TikTok, and LinkedIn are live. */
export async function getAdsPlatformAvailability(): Promise<AdsPlatformAvailability[]> {
  const [
    metaConfigured,
    googleConfigured,
    tiktokConfigured,
    linkedinConfigured,
  ] = await Promise.all([
    isMetaAppConfigured(),
    isGoogleAdsConfigured(),
    isTiktokAppConfigured(),
    isLinkedinAppConfigured(),
  ]);
  return [
    {
      platform: "meta",
      available: metaConfigured,
      reason: metaConfigured
        ? null
        : "Meta Ads is not yet available. The platform's Meta app credentials have not been configured.",
    },
    {
      platform: "google",
      available: googleConfigured,
      reason: googleConfigured
        ? null
        : "Google Ads is not yet available. The platform's Google Ads credentials have not been configured.",
    },
    {
      platform: "tiktok",
      available: tiktokConfigured,
      reason: tiktokConfigured
        ? null
        : "TikTok Ads is not yet available. The platform's TikTok for Business app credentials have not been configured.",
    },
    {
      platform: "linkedin",
      available: linkedinConfigured,
      reason: linkedinConfigured
        ? null
        : "LinkedIn Ads is not yet available. The platform's LinkedIn app credentials have not been configured.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function getAdConnection(
  tenantId: number,
  connectionId: number,
): Promise<AdAccountConnection | null> {
  const row = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.id, connectionId),
          eq(adAccountConnectionsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  // On-demand silent refresh: if this is a LinkedIn connection whose access
  // token is due to expire, renew it (via the stored refresh token) before
  // the caller uses the token. No-op for other platforms; never throws.
  return await maybeRefreshLinkedinAdsToken(row);
}

export function getConnectionToken(conn: AdAccountConnection): string | null {
  if (!conn.encryptedCredentials) return null;
  try {
    return decryptJson<MetaAdsCredentials>(conn.encryptedCredentials).accessToken ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-platform adapter dispatch
// ---------------------------------------------------------------------------

/** True when a platform API error means the grant is dead → reconnect. */
export function isAdsAuthError(err: unknown): boolean {
  return (
    (err instanceof MetaAdsApiError ||
      err instanceof GoogleAdsApiError ||
      err instanceof TiktokAdsApiError ||
      err instanceof LinkedinAdsApiError) &&
    err.authFailed
  );
}

/** HTTP-ish status carried by a platform API error, if any. */
export function adsApiErrorStatus(err: unknown): number | null {
  if (
    err instanceof MetaAdsApiError ||
    err instanceof GoogleAdsApiError ||
    err instanceof TiktokAdsApiError ||
    err instanceof LinkedinAdsApiError
  ) {
    return err.status;
  }
  return null;
}

interface CreateParams {
  name: string;
  objective: string;
  status: "ACTIVE" | "PAUSED";
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  /** LinkedIn only: the campaign group a new campaign is created in. */
  campaignGroupId?: string;
  /** What kind of object to create (campaigns everywhere; campaign groups on LinkedIn). */
  targetType?: AdsDraftTargetType;
}

interface UpdateParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudget?: number;
  lifetimeBudget?: number;
  startTime?: string;
  stopTime?: string;
  /** LinkedIn only: replacement location targeting URNs (deduped + sorted). */
  targetingLocations?: string[];
}

/**
 * The engine's per-platform surface. Adapters own auth resolution (including
 * token refresh) and unit/status normalization so the shared pipeline speaks
 * one vocabulary: minor currency units and ACTIVE/PAUSED statuses.
 */
interface PlatformOps {
  readState(
    conn: AdAccountConnection,
    targetId: string,
    targetType: AdsDraftTargetType,
  ): Promise<RemoteSnapshot>;
  update(
    conn: AdAccountConnection,
    targetId: string,
    params: UpdateParams & { targetType?: AdsDraftTargetType },
  ): Promise<void>;
  create(conn: AdAccountConnection, params: CreateParams): Promise<string>;
  defaultObjective: string;
}

function metaToken(conn: AdAccountConnection): string {
  const token = getConnectionToken(conn);
  if (!token) {
    throw new MetaAdsApiError(
      "The Meta Ads connection needs reconnecting.",
      401,
      true,
    );
  }
  return token;
}

const metaOps: PlatformOps = {
  defaultObjective: "OUTCOME_TRAFFIC",
  readState: (conn, targetId, targetType) =>
    readObjectState(metaToken(conn), targetId, asTargetType(targetType)),
  update: (conn, targetId, params) => updateObject(metaToken(conn), targetId, params),
  create: (conn, params) =>
    createCampaign(metaToken(conn), conn.adAccountId, params),
};

const googleOps: PlatformOps = {
  defaultObjective: "SEARCH",
  readState: async (conn, targetId, targetType) => {
    if (targetType === "campaign_group") {
      throw new GoogleAdsApiError(
        "Campaign groups are not a Google Ads concept.",
        400,
      );
    }
    const auth = await getGoogleAdsAuth(conn);
    if (targetType === "adset") return readGoogleAdGroupState(auth, targetId);
    if (targetType === "ad") return readGoogleAdState(auth, targetId);
    return readGoogleCampaignState(auth, targetId);
  },
  update: async (conn, targetId, params) => {
    if (params.lifetimeBudget != null) {
      throw new GoogleAdsApiError(
        "Lifetime budgets are not supported on Google Ads. Use a daily budget instead.",
        400,
      );
    }
    const targetType = params.targetType ?? "campaign";
    const auth = await getGoogleAdsAuth(conn);
    if (targetType === "adset") {
      await updateGoogleAdGroup(auth, targetId, {
        name: params.name,
        status: params.status,
        dailyBudget: params.dailyBudget ?? undefined,
      });
      return;
    }
    if (targetType === "ad") {
      if (params.name != null || params.dailyBudget != null) {
        throw new GoogleAdsApiError(
          "Google ads support pausing and activating only — names and budgets can't be changed here.",
          400,
        );
      }
      await updateGoogleAd(auth, targetId, { status: params.status });
      return;
    }
    await updateGoogleCampaign(auth, targetId, params);
  },
  create: async (conn, params) => {
    if (params.lifetimeBudget != null) {
      throw new GoogleAdsApiError(
        "Lifetime budgets are not supported for Google Ads campaigns. Use a daily budget instead.",
        400,
      );
    }
    const auth = await getGoogleAdsAuth(conn);
    return createGoogleCampaign(auth, params);
  },
};

function linkedinToken(conn: AdAccountConnection): string {
  if (!conn.encryptedCredentials) {
    throw new LinkedinAdsApiError("The LinkedIn Ads connection needs reconnecting.", 401, true);
  }
  try {
    const creds = decryptJson<LinkedinAdsCredentials>(conn.encryptedCredentials);
    if (!creds.accessToken) throw new Error("missing token");
    return creds.accessToken;
  } catch {
    throw new LinkedinAdsApiError("The LinkedIn Ads connection needs reconnecting.", 401, true);
  }
}

const linkedinOps: PlatformOps = {
  defaultObjective: "WEBSITE_VISIT",
  readState: async (conn, targetId, targetType) => {
    if (targetType === "campaign_group") {
      return readLinkedinCampaignGroupState(linkedinToken(conn), conn.adAccountId, targetId);
    }
    if (targetType === "creative") {
      return readLinkedinCreativeState(linkedinToken(conn), conn.adAccountId, targetId);
    }
    if (targetType !== "campaign") {
      throw new LinkedinAdsApiError(
        "Only campaigns and campaign groups can be managed for LinkedIn Ads in this phase.",
        400,
      );
    }
    return readLinkedinCampaignState(linkedinToken(conn), conn.adAccountId, targetId);
  },
  update: async (conn, targetId, params) => {
    if (params.targetType === "campaign_group") {
      // Groups only carry a name, status, and total (lifetime) budget; the
      // adapter converts minor units to LinkedIn's major-unit strings.
      await updateLinkedinCampaignGroup(linkedinToken(conn), conn.adAccountId, targetId, {
        name: params.name,
        status: params.status,
        lifetimeBudget: params.lifetimeBudget ?? undefined,
        currency: conn.currency ?? "USD",
      });
      return;
    }
    await updateLinkedinCampaign(linkedinToken(conn), conn.adAccountId, targetId, {
      name: params.name,
      status: params.status,
      dailyBudget: params.dailyBudget ?? undefined,
      lifetimeBudget: params.lifetimeBudget ?? undefined,
      startTime: params.startTime ?? undefined,
      stopTime: params.stopTime ?? undefined,
      currency: conn.currency ?? "USD",
      targetingLocations: params.targetingLocations,
    });
  },
  create: async (conn, params) => {
    if (params.targetType === "campaign_group") {
      return createLinkedinCampaignGroup(linkedinToken(conn), conn.adAccountId, {
        name: params.name,
        status: params.status,
        lifetimeBudget: params.lifetimeBudget,
        currency: conn.currency ?? "USD",
      });
    }
    if (!params.campaignGroupId) {
      throw new LinkedinAdsApiError(
        "A campaign group is required to create a LinkedIn campaign.",
        400,
      );
    }
    return createLinkedinCampaign(linkedinToken(conn), conn.adAccountId, {
      name: params.name,
      campaignGroupId: params.campaignGroupId,
      status: params.status,
      dailyBudget: params.dailyBudget,
      lifetimeBudget: params.lifetimeBudget,
      startTime: params.startTime,
      stopTime: params.stopTime,
      currency: conn.currency ?? "USD",
    });
  },
};

function tiktokToken(conn: AdAccountConnection): string {
  if (!conn.encryptedCredentials) {
    throw new TiktokAdsApiError("The TikTok Ads connection needs reconnecting.", 401, 0, true);
  }
  try {
    const creds = decryptJson<TiktokAdsCredentials>(conn.encryptedCredentials);
    if (!creds.accessToken) throw new Error("missing token");
    return creds.accessToken;
  } catch {
    throw new TiktokAdsApiError("The TikTok Ads connection needs reconnecting.", 401, 0, true);
  }
}

const tiktokOps: PlatformOps = {
  defaultObjective: "TRAFFIC",
  readState: async (conn, targetId, targetType) => {
    if (conn.platform === "tiktok") {
      if (targetType === "adset") {
        return readTiktokAdGroupState(tiktokToken(conn), conn.adAccountId, targetId);
      }
      if (targetType === "ad") {
        return readTiktokAdState(tiktokToken(conn), conn.adAccountId, targetId);
      }
    }
    return readTiktokCampaignState(tiktokToken(conn), conn.adAccountId, targetId);
  },
  update: async (conn, targetId, params) => {
    const targetType = params.targetType ?? "campaign";
    if (conn.platform === "tiktok") {
      if (targetType === "adset") {
        await updateTiktokAdGroup(tiktokToken(conn), conn.adAccountId, targetId, {
          name: params.name,
          status: params.status,
        });
        return;
      }
      if (targetType === "ad") {
        await updateTiktokAd(tiktokToken(conn), conn.adAccountId, targetId, {
          name: params.name,
          status: params.status,
        });
        return;
      }
    }
    await updateTiktokCampaign(tiktokToken(conn), conn.adAccountId, targetId, {
      name: params.name,
      status: params.status,
      dailyBudget: params.dailyBudget ?? undefined,
      lifetimeBudget: params.lifetimeBudget ?? undefined,
    });
  },
  create: async (conn, params) => {
    return createTiktokCampaign(tiktokToken(conn), conn.adAccountId, {
      name: params.name,
      objective: params.objective,
      status: params.status,
      dailyBudget: params.dailyBudget ?? null,
      lifetimeBudget: params.lifetimeBudget ?? null,
    });
  },
};

function getPlatformOps(platform: string): PlatformOps | null {
  if (platform === "meta") return metaOps;
  if (platform === "google") return googleOps;
  if (platform === "linkedin") return linkedinOps;
  if (platform === "tiktok") return tiktokOps;
  return null;
}

/** Read a draft target's current remote state (platform-dispatched). */
export async function readAdTargetState(
  conn: AdAccountConnection,
  targetId: string,
  targetType: AdsDraftTargetType,
): Promise<RemoteSnapshot> {
  const ops = getPlatformOps(conn.platform);
  if (!ops) {
    throw new Error(`Unsupported ads platform: ${conn.platform}`);
  }
  return ops.readState(conn, targetId, targetType);
}

/** The default create objective per platform (shown in drafts). */
export function defaultAdsObjective(platform: string): string {
  return getPlatformOps(platform)?.defaultObjective ?? "OUTCOME_TRAFFIC";
}

/**
 * Handle a downstream ad-platform auth failure (401/403) for a connection.
 * For LinkedIn, the reconnect prompt must only appear when the refresh token
 * itself is dead — so this first tries a silent token refresh and only marks
 * the row failed on a definitive rejection (or when no refresh token is
 * stored). Other platforms are marked failed immediately, as before.
 */
export async function markAdConnectionAuthFailed(
  conn: AdAccountConnection,
  message: string,
): Promise<void> {
  if (conn.platform === "linkedin") {
    await handleLinkedinAdsAuthFailure(conn, message);
    return;
  }
  await markAdConnectionFailed(conn.id, message);
}

/** Flip a connection to failed so the UI shows a reconnect prompt. */
export async function markAdConnectionFailed(
  connectionId: number,
  error: string,
): Promise<void> {
  await db
    .update(adAccountConnectionsTable)
    .set({ verifyStatus: "failed", verifyError: error, verifiedAt: new Date() })
    .where(eq(adAccountConnectionsTable.id, connectionId));
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

export interface RemoteSnapshot {
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  /** LinkedIn campaigns only: targeted location geo URNs (sorted). */
  targetingLocations?: string[];
}

/** A named targeting location as picked from the typeahead. */
export interface TargetingLocation {
  urn: string;
  name: string;
}

function sortedUrns(locations: TargetingLocation[]): string[] {
  return [...new Set(locations.map((l) => l.urn))].sort();
}

function locationNames(locations: TargetingLocation[]): string {
  return locations.map((l) => l.name).join(", ");
}

function fmtBudget(minor: number | null): string | null {
  return minor == null ? null : String(minor);
}

/** Build the human-readable before/after diff for an update draft. */
export function buildUpdateDiff(
  before: RemoteSnapshot,
  proposed: {
    name?: string;
    status?: string;
    dailyBudget?: number | null;
    lifetimeBudget?: number | null;
    startTime?: string | null;
    stopTime?: string | null;
    targetingLocations?: TargetingLocation[] | null;
  },
): AdChangeField[] {
  const fields: AdChangeField[] = [];
  if (proposed.name != null && proposed.name !== before.name) {
    fields.push({ field: "Name", before: before.name, after: proposed.name });
  }
  if (proposed.status != null && proposed.status !== before.status) {
    fields.push({ field: "Status", before: before.status, after: proposed.status });
  }
  if (proposed.dailyBudget != null && proposed.dailyBudget !== before.dailyBudget) {
    fields.push({
      field: "Daily budget (minor units)",
      before: fmtBudget(before.dailyBudget),
      after: fmtBudget(proposed.dailyBudget),
    });
  }
  if (proposed.lifetimeBudget != null && proposed.lifetimeBudget !== before.lifetimeBudget) {
    fields.push({
      field: "Lifetime budget (minor units)",
      before: fmtBudget(before.lifetimeBudget),
      after: fmtBudget(proposed.lifetimeBudget),
    });
  }
  if (proposed.startTime != null && proposed.startTime !== before.startTime) {
    fields.push({ field: "Start time", before: before.startTime, after: proposed.startTime });
  }
  if (proposed.stopTime != null && proposed.stopTime !== before.stopTime) {
    fields.push({ field: "End time", before: before.stopTime, after: proposed.stopTime });
  }
  if (
    proposed.targetingLocations != null &&
    proposed.targetingLocations.length > 0 &&
    JSON.stringify(sortedUrns(proposed.targetingLocations)) !==
      JSON.stringify(before.targetingLocations ?? [])
  ) {
    fields.push({
      field: "Target locations",
      before: (before.targetingLocations ?? []).join(", ") || null,
      after: locationNames(proposed.targetingLocations),
    });
  }
  return fields;
}

/** Human-readable diff for a creative (sponsored content) create draft. */
export function buildCreativeCreateDiff(proposed: {
  campaignName: string;
  text: string;
  imagePath?: string | null;
  landingUrl?: string | null;
  status: string;
}): AdChangeField[] {
  const fields: AdChangeField[] = [
    { field: "Campaign", before: null, after: proposed.campaignName },
    { field: "Ad text", before: null, after: proposed.text },
    { field: "Status", before: null, after: proposed.status },
  ];
  if (proposed.imagePath) {
    fields.push({ field: "Image", before: null, after: proposed.imagePath });
  }
  if (proposed.landingUrl) {
    fields.push({ field: "Landing page", before: null, after: proposed.landingUrl });
  }
  return fields;
}

export function buildCreateDiff(proposed: {
  name: string;
  objective?: string | null;
  status: string;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
}): AdChangeField[] {
  const fields: AdChangeField[] = [
    { field: "Name", before: null, after: proposed.name },
    { field: "Status", before: null, after: proposed.status },
  ];
  if (proposed.objective) {
    fields.push({ field: "Objective", before: null, after: proposed.objective });
  }
  if (proposed.dailyBudget != null) {
    fields.push({ field: "Daily budget (minor units)", before: null, after: String(proposed.dailyBudget) });
  }
  if (proposed.lifetimeBudget != null) {
    fields.push({ field: "Lifetime budget (minor units)", before: null, after: String(proposed.lifetimeBudget) });
  }
  if (proposed.startTime) fields.push({ field: "Start time", before: null, after: proposed.startTime });
  if (proposed.stopTime) fields.push({ field: "End time", before: null, after: proposed.stopTime });
  return fields;
}

/** The snapshot fields a draft compares at apply time (drift detection). */
export function snapshotForCompare(s: RemoteSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: s.name,
    status: s.status,
    dailyBudget: s.dailyBudget,
    lifetimeBudget: s.lifetimeBudget,
    startTime: s.startTime,
    stopTime: s.stopTime,
  };
  // Only present for LinkedIn campaigns; older snapshots without the key are
  // still comparable (snapshotsMatch only compares shared keys).
  if (s.targetingLocations != null) out.targetingLocations = s.targetingLocations;
  return out;
}

function snapshotsMatch(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown>,
): boolean {
  if (!a) return true;
  for (const key of Object.keys(b)) {
    if (key in a && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Apply pipeline
// ---------------------------------------------------------------------------

export const ADS_APPLY_IN_PROGRESS_MESSAGE =
  "This change is already being applied. Wait a moment for it to finish, then check the result.";

interface ApplyPayload {
  name?: string;
  objective?: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
  /** LinkedIn only: the campaign group a new campaign is created in. */
  campaignGroupId?: string;
  /** LinkedIn only: replacement location targeting for a campaign update. */
  targetingLocations?: TargetingLocation[];
  /** LinkedIn creative creates: the campaign the creative attaches to. */
  campaignId?: string;
  /** LinkedIn creative creates: the sponsored post's text. */
  text?: string;
  /** LinkedIn creative creates: tenant-scoped library image path (optional). */
  imagePath?: string | null;
  /** LinkedIn creative creates: click-through landing page URL (optional). */
  landingUrl?: string | null;
}

/**
 * Create a LinkedIn creative: fetch the (tenant-scoped) library image, upload
 * it as the advertiser org, publish a sponsored ("dark") post, then attach it
 * to the campaign. Returns the new creative id.
 */
async function applyCreativeCreate(
  conn: AdAccountConnection,
  payload: ApplyPayload,
): Promise<string> {
  if (!payload.campaignId) {
    throw new LinkedinAdsApiError(
      "A campaign is required to create a LinkedIn creative.",
      400,
    );
  }
  if (!payload.text?.trim()) {
    throw new LinkedinAdsApiError("Ad text is required to create a creative.", 400);
  }
  const token = linkedinToken(conn);
  const orgUrn = await getLinkedinAdAccountReference(token, conn.adAccountId);

  let imageUrn: string | null = null;
  if (payload.imagePath) {
    // The stored path is attacker-influenceable free-form text; the storage
    // service re-asserts the `/objects/<tenantId>/` prefix before serving.
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(payload.imagePath, conn.tenantId);
    const [metadata] = await file.getMetadata();
    const [bytes] = await file.download();
    imageUrn = await uploadLinkedinAdImage(
      token,
      orgUrn,
      bytes,
      (metadata.contentType as string) || "image/jpeg",
    );
  }

  const postUrn = await createLinkedinAdPost(
    token,
    orgUrn,
    payload.text.trim(),
    imageUrn,
    payload.landingUrl ?? null,
  );
  return createLinkedinCreative(
    token,
    conn.adAccountId,
    payload.campaignId,
    postUrn,
    payload.status ?? "PAUSED",
  );
}

/** Human-readable label for a draft's target type (error/expiry messages). */
export function targetTypeLabel(targetType: string): string {
  if (targetType === "adset") return "ad set";
  if (targetType === "ad") return "ad";
  if (targetType === "campaign_group") return "campaign group";
  if (targetType === "creative") return "creative";
  return "campaign";
}

export function asDraftTargetType(value: string): AdsDraftTargetType {
  return value === "adset" || value === "ad" || value === "campaign_group" || value === "creative"
    ? value
    : "campaign";
}

export function asTargetType(value: string): AdsTargetType {
  return value === "adset" || value === "ad" ? value : "campaign";
}

/** Draft target types the engine understands across platforms (campaign_group and creative are LinkedIn-only). */
export type AdsDraftTargetType = AdsTargetType | "campaign_group" | "creative";

/** True when the platform says the grant is expired/revoked (any platform). */
export function isPlatformAuthError(err: unknown): boolean {
  return (
    (err instanceof MetaAdsApiError && err.authFailed) ||
    (err instanceof GoogleAdsApiError && err.authFailed) ||
    (err instanceof TiktokAdsApiError && err.authFailed) ||
    (err instanceof LinkedinAdsApiError && err.authFailed)
  );
}

async function loadDraft(tenantId: number, draftId: number): Promise<AdChangeRequest | null> {
  const row = (
    await db
      .select()
      .from(adChangeRequestsTable)
      .where(
        and(
          eq(adChangeRequestsTable.id, draftId),
          eq(adChangeRequestsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
  return row ?? null;
}

async function recordChangeLog(
  draft: AdChangeRequest,
  outcome: "applied" | "failed",
  opts: {
    verifyStatus: string | null;
    failureReason: string | null;
    targetId: string | null;
    approvedByClerkUserId: string | null;
    approvedByEmail: string | null;
  },
): Promise<void> {
  try {
    await db.insert(adsChangeLogsTable).values({
      tenantId: draft.tenantId,
      changeRequestId: draft.id,
      platform: draft.platform,
      targetType: draft.targetType,
      targetId: opts.targetId,
      targetName: draft.targetName,
      action: draft.action,
      changes: draft.changes,
      outcome,
      verifyStatus: opts.verifyStatus,
      failureReason: opts.failureReason,
      approvedByClerkUserId: opts.approvedByClerkUserId,
      approvedByEmail: opts.approvedByEmail,
    });
  } catch (err) {
    // Append-only audit is best-effort; never fail the primary action.
    logger.error({ err, draftId: draft.id }, "Failed to write ads change log");
  }
}

export type ApplyResult =
  | { kind: "applied"; draft: AdChangeRequest }
  | { kind: "failed"; draft: AdChangeRequest }
  | { kind: "expired"; draft: AdChangeRequest }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "bad_status"; status: string };

/**
 * Approve and apply a draft. Owner-only enforcement happens at the route.
 * Idempotent: a draft already applied returns "bad_status" with its final
 * state; simultaneous applies are rejected by the lock + status claim.
 */
export async function approveAndApplyDraft(
  tenantId: number,
  draftId: number,
  approver: { clerkUserId: string; email: string | null },
): Promise<ApplyResult> {
  const release = tryAcquireResendLock("ads-apply", draftId);
  if (!release) return { kind: "conflict" };
  try {
    const draft = await loadDraft(tenantId, draftId);
    if (!draft) return { kind: "not_found" };
    if (draft.status !== "draft") return { kind: "bad_status", status: draft.status };

    // Atomic claim: only one request can flip draft → approved.
    const claimed = (
      await db
        .update(adChangeRequestsTable)
        .set({
          status: "approved",
          approvedByClerkUserId: approver.clerkUserId,
          approvedByEmail: approver.email,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(adChangeRequestsTable.id, draft.id),
            eq(adChangeRequestsTable.status, "draft"),
          ),
        )
        .returning()
    )[0];
    if (!claimed) return { kind: "conflict" };

    const conn = await getAdConnection(tenantId, draft.connectionId);
    const ops = conn ? getPlatformOps(conn.platform) : null;
    if (!conn || !ops || conn.status !== "connected") {
      return await finishFailed(claimed, "The ad account connection is missing or needs reconnecting.", approver);
    }

    const payload = (claimed.payload ?? {}) as ApplyPayload;

    try {
      if (claimed.action === "update") {
        if (!claimed.targetId) {
          return await finishFailed(claimed, "The draft has no target to update.", approver);
        }
        // Drift check: the remote object must still look like it did when the
        // draft was created, or the before/after preview the owner approved
        // is no longer truthful.
        const current = await ops.readState(
          conn,
          claimed.targetId,
          asDraftTargetType(claimed.targetType),
        );
        if (!snapshotsMatch(claimed.beforeSnapshot, snapshotForCompare(current))) {
          const expired = (
            await db
              .update(adChangeRequestsTable)
              .set({
                status: "expired",
                failureReason: `The ${targetTypeLabel(claimed.targetType)} changed on the ad platform after this draft was created. Review the current state and create a fresh draft.`,
                updatedAt: new Date(),
              })
              .where(eq(adChangeRequestsTable.id, claimed.id))
              .returning()
          )[0]!;
          return { kind: "expired", draft: expired };
        }

        await ops.update(conn, claimed.targetId, {
          name: payload.name,
          status: payload.status,
          dailyBudget: payload.dailyBudget ?? undefined,
          lifetimeBudget: payload.lifetimeBudget ?? undefined,
          startTime: payload.startTime ?? undefined,
          stopTime: payload.stopTime ?? undefined,
          targetingLocations: payload.targetingLocations?.length
            ? [...new Set(payload.targetingLocations.map((l) => l.urn))].sort()
            : undefined,
          targetType: asDraftTargetType(claimed.targetType),
        });

        // Post-apply verification: read back and confirm the fields we set.
        const verifyStatus = await verifyApplied(
          ops,
          conn,
          claimed.targetId,
          payload,
          asDraftTargetType(claimed.targetType),
        );
        return await finishApplied(claimed, claimed.targetId, verifyStatus, approver);
      }

      // Create: campaigns everywhere; campaign groups and creatives on LinkedIn only.
      if (claimed.targetType === "creative") {
        if (conn.platform !== "linkedin") {
          return await finishFailed(
            claimed,
            "Creatives can only be created for LinkedIn campaigns in this phase.",
            approver,
          );
        }
        const newId = await applyCreativeCreate(conn, payload);
        const verifyStatus = await verifyCreativeApplied(ops, conn, newId, payload);
        return await finishApplied(claimed, newId, verifyStatus, approver);
      }
      const creatable =
        claimed.targetType === "campaign" ||
        (claimed.targetType === "campaign_group" && conn.platform === "linkedin");
      if (!creatable) {
        return await finishFailed(
          claimed,
          claimed.targetType === "campaign_group"
            ? "Campaign groups can only be created on LinkedIn."
            : "Only campaigns can be created in this phase.",
          approver,
        );
      }
      const newId = await ops.create(conn, {
        name: payload.name ?? claimed.targetName,
        objective: payload.objective ?? ops.defaultObjective,
        status: payload.status ?? "PAUSED",
        dailyBudget: payload.dailyBudget ?? null,
        lifetimeBudget: payload.lifetimeBudget ?? null,
        startTime: payload.startTime ?? null,
        stopTime: payload.stopTime ?? null,
        campaignGroupId: payload.campaignGroupId,
        targetType: asDraftTargetType(claimed.targetType),
      });
      const verifyStatus = await verifyApplied(
        ops,
        conn,
        newId,
        payload,
        asDraftTargetType(claimed.targetType),
      );
      return await finishApplied(claimed, newId, verifyStatus, approver);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The ad platform rejected the change.";
      if (isAdsAuthError(err)) {
        await markAdConnectionAuthFailed(conn, message);
      }
      return await finishFailed(claimed, message, approver);
    }
  } finally {
    release();
  }
}

/**
 * Compare two schedule timestamps as instants; the platform may echo a
 * different textual offset/format than the one we sent.
 */
function timesEqual(a: string | null, b: string): boolean {
  if (a == null) return false;
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/**
 * Read-back verification for a freshly created creative: it must exist and
 * carry the intended status. Other snapshot fields do not apply to creatives.
 */
async function verifyCreativeApplied(
  ops: PlatformOps,
  conn: AdAccountConnection,
  creativeId: string,
  payload: ApplyPayload,
): Promise<string> {
  try {
    const state = await ops.readState(conn, creativeId, "creative");
    if (payload.status != null && state.status !== payload.status) return "mismatch";
    return "verified";
  } catch {
    // The write landed; only the read-back failed. Not a failure.
    return "unverified";
  }
}

/** Best-effort read-back verification that the applied fields stuck. */
async function verifyApplied(
  ops: PlatformOps,
  conn: AdAccountConnection,
  objectId: string,
  payload: ApplyPayload,
  targetType: AdsDraftTargetType,
): Promise<string> {
  try {
    const state = await ops.readState(conn, objectId, targetType);
    const mismatches: string[] = [];
    if (payload.name != null && state.name !== payload.name) mismatches.push("name");
    if (payload.status != null && state.status !== payload.status) mismatches.push("status");
    if (payload.dailyBudget != null && state.dailyBudget !== payload.dailyBudget) {
      mismatches.push("dailyBudget");
    }
    if (payload.lifetimeBudget != null && state.lifetimeBudget !== payload.lifetimeBudget) {
      mismatches.push("lifetimeBudget");
    }
    if (payload.startTime != null && !timesEqual(state.startTime, payload.startTime)) {
      mismatches.push("startTime");
    }
    if (payload.stopTime != null && !timesEqual(state.stopTime, payload.stopTime)) {
      mismatches.push("stopTime");
    }
    return mismatches.length === 0 ? "verified" : "mismatch";
  } catch {
    // The write landed; only the read-back failed. Not a failure.
    return "unverified";
  }
}

async function finishApplied(
  draft: AdChangeRequest,
  targetId: string,
  verifyStatus: string,
  approver: { clerkUserId: string; email: string | null },
): Promise<ApplyResult> {
  const updated = (
    await db
      .update(adChangeRequestsTable)
      .set({
        status: "applied",
        appliedAt: new Date(),
        resultTargetId: draft.action === "create" ? targetId : null,
        targetId,
        verifyStatus,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(adChangeRequestsTable.id, draft.id))
      .returning()
  )[0]!;
  await recordChangeLog(draft, "applied", {
    verifyStatus,
    failureReason: null,
    targetId,
    approvedByClerkUserId: approver.clerkUserId,
    approvedByEmail: approver.email,
  });
  await notifyAdsChangeApplied(draft.tenantId, draft.targetName, draft.platform);
  return { kind: "applied", draft: updated };
}

async function finishFailed(
  draft: AdChangeRequest,
  reason: string,
  approver: { clerkUserId: string; email: string | null },
): Promise<ApplyResult> {
  const updated = (
    await db
      .update(adChangeRequestsTable)
      .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
      .where(eq(adChangeRequestsTable.id, draft.id))
      .returning()
  )[0]!;
  await recordChangeLog(draft, "failed", {
    verifyStatus: null,
    failureReason: reason,
    targetId: draft.targetId,
    approvedByClerkUserId: approver.clerkUserId,
    approvedByEmail: approver.email,
  });
  await notifyAdsChangeFailed(draft.tenantId, draft.targetName, draft.platform, reason);
  return { kind: "failed", draft: updated };
}

// Re-export for routes that need the campaign read for draft creation.
export { getCampaign };
