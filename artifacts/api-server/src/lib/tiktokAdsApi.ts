import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import { platformFetch } from "./platformFetch";

/**
 * TikTok for Business (Marketing API v1.3) adapter for the paid-media module.
 *
 * All calls go through the bounded-timeout `platformFetch`; the access token
 * always travels in the `Access-Token` header and the app secret only ever in
 * a POST body — never in a URL, so neither can leak into proxy access logs.
 *
 * TikTok wraps every response in `{ code, message, data }` where code 0 means
 * success. Failures throw `TiktokAdsApiError` with a user-presentable message
 * and an `authFailed` hint (token expired/revoked/permission codes) so callers
 * can surface a reconnect prompt.
 *
 * Unit conventions: TikTok reports budgets as floats in the advertiser
 * currency's MAJOR units; this adapter converts to/from integer minor units
 * (x100) so the shared drafts/diff/verify pipeline sees one consistent unit.
 * Statuses are mapped ENABLE<->ACTIVE and DISABLE<->PAUSED for the same
 * reason.
 */

const TIKTOK_BASE_DEFAULT = "https://business-api.tiktok.com/open_api/v1.3";
export const TIKTOK_AUTH_PORTAL = "https://business-api.tiktok.com/portal/auth";

/** Dev/test-only escape hatch so tests can point API calls at a mock. */
function tiktokBase(): string {
  return (
    (process.env.NODE_ENV !== "production" &&
      process.env.TIKTOK_ADS_BASE_OVERRIDE) ||
    TIKTOK_BASE_DEFAULT
  );
}

/** App-level TikTok for Business credentials stored encrypted in app_credentials. */
export interface TiktokAppCredentials {
  appId: string;
  appSecret: string;
}

/**
 * Per-tenant TikTok ads credentials stored encrypted on the connection row.
 * `advertiserIds` is captured from the token exchange so advertiser discovery
 * never needs the app secret in a query string.
 */
export interface TiktokAdsCredentials {
  accessToken: string;
  advertiserIds?: string[];
}

export async function getTiktokAppCredentials(): Promise<TiktokAppCredentials | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "tiktok"))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<TiktokAppCredentials>(row.encryptedCredentials);
    return creds.appId && creds.appSecret ? creds : null;
  } catch {
    return null;
  }
}

export async function isTiktokAppConfigured(): Promise<boolean> {
  return (await getTiktokAppCredentials()) != null;
}

export class TiktokAdsApiError extends Error {
  status: number;
  /** TikTok business-level error code (0 = success). */
  code: number;
  /** True when the token is expired/revoked or permissions are missing. */
  authFailed: boolean;
  constructor(message: string, status: number, code: number, authFailed = false) {
    super(message);
    this.name = "TiktokAdsApiError";
    this.status = status;
    this.code = code;
    this.authFailed = authFailed;
  }
}

/** Token invalid/expired/revoked or the app lost permission for the advertiser. */
const AUTH_FAILED_CODES = new Set([40101, 40102, 40104, 40105, 40001]);

interface TiktokEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

function unwrap<T>(json: TiktokEnvelope<T>, httpStatus: number): T {
  const code = json.code ?? -1;
  if (httpStatus >= 200 && httpStatus < 300 && code === 0) {
    return (json.data ?? {}) as T;
  }
  throw new TiktokAdsApiError(
    json.message || `TikTok Ads API error (${httpStatus})`,
    httpStatus,
    code,
    AUTH_FAILED_CODES.has(code) || httpStatus === 401,
  );
}

async function apiGet<T>(
  path: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await platformFetch(`${tiktokBase()}/${path}?${qs}`, {
    headers: { "Access-Token": token },
  });
  const json = (await res.json()) as TiktokEnvelope<T>;
  return unwrap(json, res.status);
}

async function apiPost<T>(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await platformFetch(`${tiktokBase()}/${path}`, {
    method: "POST",
    headers: { "Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TiktokEnvelope<T>;
  return unwrap(json, res.status);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Exchange the auth_code from the TikTok portal redirect for a long-lived
 * access token. The app secret travels in the JSON POST body only.
 */
export async function exchangeAuthCode(
  creds: TiktokAppCredentials,
  authCode: string,
): Promise<TiktokAdsCredentials> {
  const res = await platformFetch(`${tiktokBase()}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: creds.appId,
      secret: creds.appSecret,
      auth_code: authCode,
    }),
  });
  const json = (await res.json()) as TiktokEnvelope<{
    access_token?: string;
    advertiser_ids?: (string | number)[];
  }>;
  const data = unwrap(json, res.status);
  if (!data.access_token) {
    throw new TiktokAdsApiError("TikTok did not return an access token.", 502, -1);
  }
  return {
    accessToken: data.access_token,
    advertiserIds: (data.advertiser_ids ?? []).map(String),
  };
}

// ---------------------------------------------------------------------------
// Advertiser accounts
// ---------------------------------------------------------------------------

export interface TiktokAdvertiser {
  advertiserId: string;
  name: string;
  currency: string | null;
  status: string | null;
}

/** Read advertiser names/currency for the granted advertiser ids. */
export async function listAdvertisers(
  token: string,
  advertiserIds: string[],
): Promise<TiktokAdvertiser[]> {
  if (advertiserIds.length === 0) return [];
  const data = await apiGet<{
    list?: {
      advertiser_id?: string | number;
      name?: string;
      currency?: string;
      status?: string;
    }[];
  }>("advertiser/info/", token, {
    advertiser_ids: JSON.stringify(advertiserIds.slice(0, 100)),
  });
  return (data.list ?? []).map((a) => ({
    advertiserId: String(a.advertiser_id ?? ""),
    name: a.name ?? String(a.advertiser_id ?? "Advertiser"),
    currency: a.currency ?? null,
    status: a.status ?? null,
  }));
}

/** Verify the token can read the given advertiser; returns its name/currency. */
export async function readAdvertiser(
  token: string,
  advertiserId: string,
): Promise<{ name: string; currency: string | null }> {
  const list = await listAdvertisers(token, [advertiserId]);
  const hit = list.find((a) => a.advertiserId === advertiserId);
  if (!hit) {
    throw new TiktokAdsApiError(
      "TikTok did not return that advertiser account for this grant.",
      404,
      -1,
    );
  }
  return { name: hit.name, currency: hit.currency };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface TiktokCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}

function toMinor(budget: number | string | null | undefined): number | null {
  if (budget == null || budget === "") return null;
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function toMajor(minor: number): number {
  return minor / 100;
}

function mapOperationStatus(op: string | undefined): string {
  if (op === "ENABLE") return "ACTIVE";
  if (op === "DISABLE") return "PAUSED";
  return op ?? "UNKNOWN";
}

function toOperationStatus(status: "ACTIVE" | "PAUSED"): "ENABLE" | "DISABLE" {
  return status === "ACTIVE" ? "ENABLE" : "DISABLE";
}

interface RawTiktokCampaign {
  campaign_id?: string | number;
  campaign_name?: string;
  operation_status?: string;
  secondary_status?: string;
  objective_type?: string;
  budget?: number | string;
  budget_mode?: string;
}

function mapCampaign(c: RawTiktokCampaign): TiktokCampaign {
  const minor = toMinor(c.budget);
  const isDaily = c.budget_mode === "BUDGET_MODE_DAY";
  const isTotal = c.budget_mode === "BUDGET_MODE_TOTAL";
  return {
    id: String(c.campaign_id ?? ""),
    name: c.campaign_name ?? "",
    status: mapOperationStatus(c.operation_status),
    effectiveStatus: c.secondary_status ?? mapOperationStatus(c.operation_status),
    objective: c.objective_type ?? null,
    dailyBudget: isDaily ? minor : null,
    lifetimeBudget: isTotal ? minor : null,
    // TikTok schedules live on ad groups, not campaigns.
    startTime: null,
    stopTime: null,
  };
}

export async function listCampaigns(
  token: string,
  advertiserId: string,
): Promise<TiktokCampaign[]> {
  const data = await apiGet<{ list?: RawTiktokCampaign[] }>(
    "campaign/get/",
    token,
    { advertiser_id: advertiserId, page_size: "100" },
  );
  return (data.list ?? []).map(mapCampaign);
}

export async function getCampaign(
  token: string,
  advertiserId: string,
  campaignId: string,
): Promise<TiktokCampaign> {
  const data = await apiGet<{ list?: RawTiktokCampaign[] }>(
    "campaign/get/",
    token,
    {
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ campaign_ids: [campaignId] }),
      page_size: "10",
    },
  );
  const hit = (data.list ?? []).map(mapCampaign).find((c) => c.id === campaignId);
  if (!hit) {
    throw new TiktokAdsApiError("TikTok campaign not found.", 404, -1);
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Ad groups + ads (reads for the campaign detail view)
// ---------------------------------------------------------------------------

export interface TiktokAdGroup {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}

interface RawTiktokAdGroup {
  adgroup_id?: string | number;
  adgroup_name?: string;
  operation_status?: string;
  secondary_status?: string;
  budget?: number | string;
  budget_mode?: string;
}

function mapAdGroup(g: RawTiktokAdGroup): TiktokAdGroup {
  const minor = toMinor(g.budget);
  return {
    id: String(g.adgroup_id ?? ""),
    name: g.adgroup_name ?? "",
    status: mapOperationStatus(g.operation_status),
    effectiveStatus: g.secondary_status ?? mapOperationStatus(g.operation_status),
    dailyBudget: g.budget_mode === "BUDGET_MODE_DAY" ? minor : null,
    lifetimeBudget: g.budget_mode === "BUDGET_MODE_TOTAL" ? minor : null,
  };
}

export async function listAdGroups(
  token: string,
  advertiserId: string,
  campaignId: string,
): Promise<TiktokAdGroup[]> {
  const data = await apiGet<{ list?: RawTiktokAdGroup[] }>("adgroup/get/", token, {
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ campaign_ids: [campaignId] }),
    page_size: "100",
  });
  return (data.list ?? []).map(mapAdGroup);
}

export interface TiktokAd {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  adGroupId: string | null;
}

interface RawTiktokAd {
  ad_id?: string | number;
  ad_name?: string;
  operation_status?: string;
  secondary_status?: string;
  adgroup_id?: string | number;
}

function mapAd(a: RawTiktokAd): TiktokAd {
  return {
    id: String(a.ad_id ?? ""),
    name: a.ad_name ?? "",
    status: mapOperationStatus(a.operation_status),
    effectiveStatus: a.secondary_status ?? mapOperationStatus(a.operation_status),
    adGroupId: a.adgroup_id != null ? String(a.adgroup_id) : null,
  };
}

export async function listAdsForCampaign(
  token: string,
  advertiserId: string,
  campaignId: string,
): Promise<TiktokAd[]> {
  const data = await apiGet<{ list?: RawTiktokAd[] }>("ad/get/", token, {
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ campaign_ids: [campaignId] }),
    page_size: "100",
  });
  return (data.list ?? []).map(mapAd);
}

/** Fetch a single ad group by id (draft snapshot + verify read-back). */
export async function getAdGroup(
  token: string,
  advertiserId: string,
  adGroupId: string,
): Promise<TiktokAdGroup> {
  const data = await apiGet<{ list?: RawTiktokAdGroup[] }>("adgroup/get/", token, {
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ adgroup_ids: [adGroupId] }),
    page_size: "10",
  });
  const hit = (data.list ?? []).map(mapAdGroup).find((g) => g.id === adGroupId);
  if (!hit) {
    throw new TiktokAdsApiError("TikTok ad group not found.", 404, -1);
  }
  return hit;
}

/** Fetch a single ad by id (draft snapshot + verify read-back). */
export async function getAd(
  token: string,
  advertiserId: string,
  adId: string,
): Promise<TiktokAd> {
  const data = await apiGet<{ list?: RawTiktokAd[] }>("ad/get/", token, {
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ ad_ids: [adId] }),
    page_size: "10",
  });
  const hit = (data.list ?? []).map(mapAd).find((a) => a.id === adId);
  if (!hit) {
    throw new TiktokAdsApiError("TikTok ad not found.", 404, -1);
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Reporting (spend/metrics over date ranges)
// ---------------------------------------------------------------------------

export interface TiktokInsights {
  impressions: number;
  clicks: number;
  ctr: number;
  spend: number;
  results: number;
}

export const EMPTY_TIKTOK_INSIGHTS: TiktokInsights = {
  impressions: 0,
  clicks: 0,
  ctr: 0,
  spend: 0,
  results: 0,
};

/** Shared date presets translated to TikTok's explicit start/end dates. */
export function presetToDateRange(
  preset: string,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date(now);
  const start = new Date(now);
  switch (preset) {
    case "today":
      break;
    case "yesterday":
      start.setUTCDate(start.getUTCDate() - 1);
      end.setUTCDate(end.getUTCDate() - 1);
      break;
    case "last_7d":
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case "last_14d":
      start.setUTCDate(start.getUTCDate() - 14);
      break;
    case "last_90d":
      start.setUTCDate(start.getUTCDate() - 90);
      break;
    case "maximum":
      // TikTok reporting caps a single query window; one year is a practical "all".
      start.setUTCDate(start.getUTCDate() - 365);
      break;
    case "last_30d":
    default:
      start.setUTCDate(start.getUTCDate() - 30);
      break;
  }
  return { startDate: fmt(start), endDate: fmt(end) };
}

const REPORT_LEVELS = {
  campaign: { dataLevel: "AUCTION_CAMPAIGN", idDim: "campaign_id" },
  adgroup: { dataLevel: "AUCTION_ADGROUP", idDim: "adgroup_id" },
  ad: { dataLevel: "AUCTION_AD", idDim: "ad_id" },
} as const;

/**
 * Fetch metrics for the whole advertiser at the given level, keyed by the
 * object id at that level. Objects with no delivery simply have no row.
 */
export async function getInsightsByLevel(
  token: string,
  advertiserId: string,
  level: keyof typeof REPORT_LEVELS,
  datePreset: string,
): Promise<Map<string, TiktokInsights>> {
  const { dataLevel, idDim } = REPORT_LEVELS[level];
  const { startDate, endDate } = presetToDateRange(datePreset);
  const data = await apiGet<{
    list?: {
      dimensions?: Record<string, string | number>;
      metrics?: Record<string, string | number>;
    }[];
  }>("report/integrated/get/", token, {
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: dataLevel,
    dimensions: JSON.stringify([idDim]),
    metrics: JSON.stringify(["impressions", "clicks", "ctr", "spend", "conversion"]),
    start_date: startDate,
    end_date: endDate,
    page_size: "500",
  });
  const num = (v: string | number | undefined): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const map = new Map<string, TiktokInsights>();
  for (const row of data.list ?? []) {
    const id = row.dimensions?.[idDim];
    if (id == null || id === "") continue;
    map.set(String(id), {
      impressions: num(row.metrics?.impressions),
      clicks: num(row.metrics?.clicks),
      ctr: num(row.metrics?.ctr),
      spend: num(row.metrics?.spend),
      results: num(row.metrics?.conversion),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Writes (called only by the shared draft-and-approve engine)
// ---------------------------------------------------------------------------

export interface TiktokCreateCampaignParams {
  name: string;
  objective: string;
  status: "ACTIVE" | "PAUSED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
}

/** Create a campaign; returns the new campaign id. */
export async function createCampaign(
  token: string,
  advertiserId: string,
  params: TiktokCreateCampaignParams,
): Promise<string> {
  const body: Record<string, unknown> = {
    advertiser_id: advertiserId,
    campaign_name: params.name,
    objective_type: params.objective,
    operation_status: toOperationStatus(params.status),
  };
  if (params.dailyBudget != null) {
    body.budget_mode = "BUDGET_MODE_DAY";
    body.budget = toMajor(params.dailyBudget);
  } else if (params.lifetimeBudget != null) {
    body.budget_mode = "BUDGET_MODE_TOTAL";
    body.budget = toMajor(params.lifetimeBudget);
  } else {
    body.budget_mode = "BUDGET_MODE_INFINITE";
  }
  const data = await apiPost<{ campaign_id?: string | number }>(
    "campaign/create/",
    token,
    body,
  );
  if (data.campaign_id == null) {
    throw new TiktokAdsApiError("TikTok did not return a campaign id.", 502, -1);
  }
  return String(data.campaign_id);
}

export interface TiktokUpdateCampaignParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
}

/**
 * Update a campaign in place. Name/budget go through campaign/update/; the
 * pause/resume flip uses the dedicated campaign/status/update/ endpoint.
 */
export async function updateCampaign(
  token: string,
  advertiserId: string,
  campaignId: string,
  params: TiktokUpdateCampaignParams,
): Promise<void> {
  const body: Record<string, unknown> = {
    advertiser_id: advertiserId,
    campaign_id: campaignId,
  };
  let hasFieldUpdate = false;
  if (params.name != null) {
    body.campaign_name = params.name;
    hasFieldUpdate = true;
  }
  if (params.dailyBudget != null) {
    body.budget_mode = "BUDGET_MODE_DAY";
    body.budget = toMajor(params.dailyBudget);
    hasFieldUpdate = true;
  } else if (params.lifetimeBudget != null) {
    body.budget_mode = "BUDGET_MODE_TOTAL";
    body.budget = toMajor(params.lifetimeBudget);
    hasFieldUpdate = true;
  }
  if (hasFieldUpdate) {
    await apiPost("campaign/update/", token, body);
  }
  if (params.status != null) {
    await apiPost("campaign/status/update/", token, {
      advertiser_id: advertiserId,
      campaign_ids: [campaignId],
      operation_status: toOperationStatus(params.status),
    });
  }
}

/** Read the current state of a campaign (drift check + post-apply verify). */
export async function readCampaignState(
  token: string,
  advertiserId: string,
  campaignId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}> {
  const c = await getCampaign(token, advertiserId, campaignId);
  return {
    name: c.name,
    status: c.status,
    dailyBudget: c.dailyBudget,
    lifetimeBudget: c.lifetimeBudget,
    startTime: null,
    stopTime: null,
  };
}

export interface TiktokUpdateAdGroupParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
}

/**
 * Update an ad group in place (name, status, budget). Name/budget go through
 * adgroup/update/; the pause/resume flip uses adgroup/status/update/. Budgets
 * are stored in minor units internally but TikTok expects major units
 * (budget_mode + budget), like campaigns.
 */
export async function updateAdGroup(
  token: string,
  advertiserId: string,
  adGroupId: string,
  params: TiktokUpdateAdGroupParams,
): Promise<void> {
  const body: Record<string, unknown> = {
    advertiser_id: advertiserId,
    adgroup_id: adGroupId,
  };
  let hasFieldUpdate = false;
  if (params.name != null) {
    body.adgroup_name = params.name;
    hasFieldUpdate = true;
  }
  if (params.dailyBudget != null) {
    body.budget_mode = "BUDGET_MODE_DAY";
    body.budget = toMajor(params.dailyBudget);
    hasFieldUpdate = true;
  } else if (params.lifetimeBudget != null) {
    body.budget_mode = "BUDGET_MODE_TOTAL";
    body.budget = toMajor(params.lifetimeBudget);
    hasFieldUpdate = true;
  }
  if (hasFieldUpdate) {
    await apiPost("adgroup/update/", token, body);
  }
  if (params.status != null) {
    await apiPost("adgroup/status/update/", token, {
      advertiser_id: advertiserId,
      adgroup_ids: [adGroupId],
      operation_status: toOperationStatus(params.status),
    });
  }
}

export interface TiktokUpdateAdParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
}

/**
 * Update an ad in place (name/status only). Rename goes through ad/update/,
 * which is keyed by the parent ad group, so the ad is fetched first to learn
 * its adgroup_id. The pause/resume flip uses ad/status/update/.
 */
export async function updateAd(
  token: string,
  advertiserId: string,
  adId: string,
  params: TiktokUpdateAdParams,
): Promise<void> {
  if (params.name != null) {
    const ad = await getAd(token, advertiserId, adId);
    if (!ad.adGroupId) {
      throw new TiktokAdsApiError(
        "TikTok did not report the ad's parent ad group; the ad cannot be renamed.",
        502,
        -1,
      );
    }
    await apiPost("ad/update/", token, {
      advertiser_id: advertiserId,
      adgroup_id: ad.adGroupId,
      creatives: [{ ad_id: adId, ad_name: params.name }],
    });
  }
  if (params.status != null) {
    await apiPost("ad/status/update/", token, {
      advertiser_id: advertiserId,
      ad_ids: [adId],
      operation_status: toOperationStatus(params.status),
    });
  }
}

/** Read the current state of an ad group (drift check + post-apply verify). */
export async function readAdGroupState(
  token: string,
  advertiserId: string,
  adGroupId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}> {
  const g = await getAdGroup(token, advertiserId, adGroupId);
  return {
    name: g.name,
    status: g.status,
    dailyBudget: g.dailyBudget,
    lifetimeBudget: g.lifetimeBudget,
    // Ad group schedule editing is not supported yet; keep the snapshot
    // schedule-free so drafts never expire on schedule drift we don't manage.
    startTime: null,
    stopTime: null,
  };
}

/** Read the current state of an ad (drift check + post-apply verify). */
export async function readAdState(
  token: string,
  advertiserId: string,
  adId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}> {
  const a = await getAd(token, advertiserId, adId);
  return {
    name: a.name,
    status: a.status,
    dailyBudget: null,
    lifetimeBudget: null,
    startTime: null,
    stopTime: null,
  };
}
