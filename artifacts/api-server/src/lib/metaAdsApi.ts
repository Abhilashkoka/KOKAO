import { GRAPH_BASE } from "./metaApi";
import { platformFetch } from "./platformFetch";

/**
 * Meta Marketing API adapter for the paid-media module.
 *
 * All calls go through the bounded-timeout `platformFetch`; the access token
 * always travels in the Authorization header (GET reads) or the POST body
 * (writes) — never in a URL, so it can't leak into proxy access logs.
 *
 * Read failures throw `MetaAdsApiError` with a user-presentable message and
 * an `authFailed` hint so callers can surface a reconnect prompt (Meta OAuth
 * error codes 190/102 and subcode families mean the token is dead).
 */

/** Per-tenant Meta ads credentials stored encrypted on the connection row. */
export interface MetaAdsCredentials {
  accessToken: string;
}

export class MetaAdsApiError extends Error {
  status: number;
  /** True when the token is expired/revoked or permissions are missing. */
  authFailed: boolean;
  constructor(message: string, status: number, authFailed = false) {
    super(message);
    this.name = "MetaAdsApiError";
    this.status = status;
    this.authFailed = authFailed;
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

function toApiError(json: GraphErrorBody, status: number): MetaAdsApiError {
  const code = json.error?.code;
  const authFailed =
    code === 190 || code === 102 || code === 10 || code === 200 ||
    json.error?.type === "OAuthException";
  return new MetaAdsApiError(
    json.error?.message || `Meta Ads API error (${status})`,
    status,
    authFailed,
  );
}

async function graphGet<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  const res = await platformFetch(`${adsGraphBase()}/${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as T & GraphErrorBody;
  if (!res.ok || json.error) throw toApiError(json, res.status);
  return json;
}

async function graphPost<T>(path: string, token: string, body: Record<string, string>): Promise<T> {
  const res = await platformFetch(`${adsGraphBase()}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as T & GraphErrorBody;
  if (!res.ok || json.error) throw toApiError(json, res.status);
  return json;
}

/** Dev/test-only escape hatch so tests can point Graph calls at a mock. */
function adsGraphBase(): string {
  return (
    (process.env.NODE_ENV !== "production" &&
      process.env.META_ADS_GRAPH_BASE_OVERRIDE) ||
    GRAPH_BASE
  );
}

export interface MetaAdAccount {
  adAccountId: string;
  name: string;
  currency: string | null;
  accountStatus: string | null;
}

/** List ad accounts the token's user can manage. */
export async function listAdAccounts(token: string): Promise<MetaAdAccount[]> {
  const json = await graphGet<{
    data?: { id?: string; account_id?: string; name?: string; currency?: string; account_status?: number }[];
  }>("me/adaccounts", token, {
    fields: "id,account_id,name,currency,account_status",
    limit: "100",
  });
  return (json.data ?? []).map((a) => ({
    adAccountId: a.id ?? `act_${a.account_id}`,
    name: a.name ?? a.id ?? "Ad account",
    currency: a.currency ?? null,
    accountStatus:
      a.account_status === 1
        ? "ACTIVE"
        : a.account_status != null
          ? String(a.account_status)
          : null,
  }));
}

/** Verify the token can read the given ad account; returns its name/currency. */
export async function readAdAccount(
  token: string,
  adAccountId: string,
): Promise<{ name: string; currency: string | null }> {
  const json = await graphGet<{ name?: string; currency?: string }>(
    encodeURIComponent(adAccountId),
    token,
    { fields: "id,name,currency" },
  );
  return { name: json.name ?? adAccountId, currency: json.currency ?? null };
}

export interface MetaCampaign {
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

const CAMPAIGN_FIELDS =
  "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time";

function toNum(v: string | undefined | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface RawCampaign {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  stop_time?: string;
  /** Ad sets only: their end timestamp field is named end_time. */
  end_time?: string;
  /** Ad sets only: bid cap / cost cap amount in minor units. */
  bid_amount?: string | number;
  /** Ad sets only: bid strategy (when the ad set holds its own budget). */
  bid_strategy?: string;
}

function mapCampaign(c: RawCampaign): MetaCampaign {
  return {
    id: c.id ?? "",
    name: c.name ?? "",
    status: c.status ?? "UNKNOWN",
    effectiveStatus: c.effective_status ?? c.status ?? "UNKNOWN",
    objective: c.objective ?? null,
    dailyBudget: toNum(c.daily_budget),
    lifetimeBudget: toNum(c.lifetime_budget),
    startTime: c.start_time ?? null,
    stopTime: c.stop_time ?? null,
  };
}

export async function listCampaigns(
  token: string,
  adAccountId: string,
): Promise<MetaCampaign[]> {
  const json = await graphGet<{ data?: RawCampaign[] }>(
    `${encodeURIComponent(adAccountId)}/campaigns`,
    token,
    { fields: CAMPAIGN_FIELDS, limit: "100" },
  );
  return (json.data ?? []).map(mapCampaign);
}

export async function getCampaign(
  token: string,
  campaignId: string,
): Promise<MetaCampaign> {
  const json = await graphGet<RawCampaign>(encodeURIComponent(campaignId), token, {
    fields: CAMPAIGN_FIELDS,
  });
  return mapCampaign(json);
}

export interface MetaAdSet {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  /** Meta ad sets call this `end_time` (campaigns use `stop_time`). */
  stopTime: string | null;
  /** Bid cap / cost cap in minor currency units; null when the ad set has no cap. */
  bidAmount: number | null;
  bidStrategy: string | null;
}

export async function listAdSets(
  token: string,
  campaignId: string,
): Promise<MetaAdSet[]> {
  const json = await graphGet<{
    data?: {
      id?: string; name?: string; status?: string; effective_status?: string;
      daily_budget?: string; lifetime_budget?: string;
      start_time?: string; end_time?: string;
      bid_amount?: string; bid_strategy?: string;
    }[];
  }>(`${encodeURIComponent(campaignId)}/adsets`, token, {
    fields: "id,name,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,bid_amount,bid_strategy",
    limit: "100",
  });
  return (json.data ?? []).map((s) => ({
    id: s.id ?? "",
    name: s.name ?? "",
    status: s.status ?? "UNKNOWN",
    effectiveStatus: s.effective_status ?? s.status ?? "UNKNOWN",
    dailyBudget: toNum(s.daily_budget),
    lifetimeBudget: toNum(s.lifetime_budget),
    startTime: s.start_time ?? null,
    stopTime: s.end_time ?? null,
    bidAmount: toNum(s.bid_amount),
    bidStrategy: s.bid_strategy ?? null,
  }));
}

export interface MetaAd {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  adSetId: string | null;
  /** Ad copy resolved from the ad's creative, when available. */
  text: string | null;
  /** Thumbnail/image URL resolved from the ad's creative, when available. */
  imageUrl: string | null;
}

interface RawMetaAdCreative {
  body?: string;
  title?: string;
  image_url?: string;
  thumbnail_url?: string;
  object_story_spec?: {
    link_data?: { message?: string; picture?: string };
    photo_data?: { caption?: string };
    video_data?: { message?: string; image_url?: string };
  };
  asset_feed_spec?: {
    bodies?: { text?: string }[];
  };
}

/** Best-effort extraction of ad copy + image from a Meta creative payload. */
function creativePreview(c: RawMetaAdCreative | undefined): {
  text: string | null;
  imageUrl: string | null;
} {
  if (!c) return { text: null, imageUrl: null };
  const spec = c.object_story_spec;
  const text =
    c.body ??
    spec?.link_data?.message ??
    spec?.video_data?.message ??
    spec?.photo_data?.caption ??
    c.asset_feed_spec?.bodies?.[0]?.text ??
    c.title ??
    null;
  const imageUrl =
    c.image_url ??
    spec?.link_data?.picture ??
    spec?.video_data?.image_url ??
    c.thumbnail_url ??
    null;
  return { text: text || null, imageUrl: imageUrl || null };
}

export async function listAds(token: string, campaignId: string): Promise<MetaAd[]> {
  const json = await graphGet<{
    data?: {
      id?: string; name?: string; status?: string; effective_status?: string;
      adset_id?: string; creative?: RawMetaAdCreative;
    }[];
  }>(`${encodeURIComponent(campaignId)}/ads`, token, {
    fields:
      "id,name,status,effective_status,adset_id,creative{body,title,image_url,thumbnail_url,object_story_spec,asset_feed_spec}",
    limit: "200",
  });
  return (json.data ?? []).map((a) => {
    const preview = creativePreview(a.creative);
    return {
      id: a.id ?? "",
      name: a.name ?? "",
      status: a.status ?? "UNKNOWN",
      effectiveStatus: a.effective_status ?? a.status ?? "UNKNOWN",
      adSetId: a.adset_id ?? null,
      text: preview.text,
      imageUrl: preview.imageUrl,
    };
  });
}

export interface MetaInsights {
  impressions: number;
  clicks: number;
  ctr: number;
  spend: number;
  results: number;
}

export const EMPTY_INSIGHTS: MetaInsights = {
  impressions: 0,
  clicks: 0,
  ctr: 0,
  spend: 0,
  results: 0,
};

export type AdsDatePreset =
  | "today"
  | "yesterday"
  | "last_7d"
  | "last_14d"
  | "last_30d"
  | "last_90d"
  | "maximum";

export const ADS_DATE_PRESETS: AdsDatePreset[] = [
  "today", "yesterday", "last_7d", "last_14d", "last_30d", "last_90d", "maximum",
];

/** Priority of action types counted as "results" (first present wins). */
const RESULT_ACTION_PRIORITY = [
  "purchase",
  "lead",
  "complete_registration",
  "link_click",
  "post_engagement",
  "video_view",
];

interface RawInsightRow {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  spend?: string;
  actions?: { action_type?: string; value?: string }[];
}

function mapInsights(row: RawInsightRow): MetaInsights {
  let results = 0;
  const actions = row.actions ?? [];
  for (const type of RESULT_ACTION_PRIORITY) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) {
      results = toNum(hit.value) ?? 0;
      break;
    }
  }
  return {
    impressions: toNum(row.impressions) ?? 0,
    clicks: toNum(row.clicks) ?? 0,
    ctr: toNum(row.ctr) ?? 0,
    spend: toNum(row.spend) ?? 0,
    results,
  };
}

/**
 * Fetch insights for the whole ad account at the given level, keyed by the
 * object id at that level. Objects with no delivery simply have no row.
 */
export async function getInsightsByLevel(
  token: string,
  adAccountId: string,
  level: "campaign" | "adset" | "ad",
  datePreset: AdsDatePreset,
): Promise<Map<string, MetaInsights>> {
  const idField = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
  const json = await graphGet<{ data?: RawInsightRow[] }>(
    `${encodeURIComponent(adAccountId)}/insights`,
    token,
    {
      level,
      fields: `${idField},impressions,clicks,ctr,spend,actions`,
      date_preset: datePreset,
      limit: "500",
    },
  );
  const map = new Map<string, MetaInsights>();
  for (const row of json.data ?? []) {
    const id = row[idField as keyof RawInsightRow];
    if (typeof id === "string" && id) map.set(id, mapInsights(row));
  }
  return map;
}

export interface CreateCampaignParams {
  name: string;
  objective: string;
  status: "ACTIVE" | "PAUSED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
}

/** Create a campaign; returns the new campaign id. */
export async function createCampaign(
  token: string,
  adAccountId: string,
  params: CreateCampaignParams,
): Promise<string> {
  const body: Record<string, string> = {
    name: params.name,
    objective: params.objective,
    status: params.status,
    // Required by the Marketing API; empty unless the advertiser declares one.
    special_ad_categories: "[]",
  };
  if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
  if (params.lifetimeBudget != null) body.lifetime_budget = String(params.lifetimeBudget);
  if (params.startTime) body.start_time = params.startTime;
  if (params.stopTime) body.stop_time = params.stopTime;
  const json = await graphPost<{ id?: string }>(
    `${encodeURIComponent(adAccountId)}/campaigns`,
    token,
    body,
  );
  if (!json.id) throw new MetaAdsApiError("Meta did not return a campaign id.", 502);
  return json.id;
}

export interface UpdateObjectParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED" | "ARCHIVED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
  /** Ad sets only: bid cap / cost cap amount in minor units. */
  bidAmount?: number | null;
  /** Ad sets only: bid strategy (requires the ad set to hold its own budget). */
  bidStrategy?: string | null;
  /**
   * Which Graph object is being updated. Ad sets name their end timestamp
   * `end_time` while campaigns use `stop_time`, so the mapping depends on it.
   */
  targetType?: AdsTargetType;
}

/** Update a campaign/ad set/ad in place (POST to the object id). */
export async function updateObject(
  token: string,
  objectId: string,
  params: UpdateObjectParams,
): Promise<void> {
  const body: Record<string, string> = {};
  if (params.name != null) body.name = params.name;
  if (params.status != null) body.status = params.status;
  if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
  if (params.lifetimeBudget != null) body.lifetime_budget = String(params.lifetimeBudget);
  if (params.startTime != null) body.start_time = params.startTime;
  if (params.stopTime != null) {
    if (params.targetType === "adset") body.end_time = params.stopTime;
    else body.stop_time = params.stopTime;
  }
  // Bid tuning is an ad-set knob; campaigns/ads never receive these fields.
  if (params.targetType === "adset") {
    if (params.bidAmount != null) body.bid_amount = String(params.bidAmount);
    if (params.bidStrategy != null) body.bid_strategy = params.bidStrategy;
  }
  await graphPost<{ success?: boolean }>(encodeURIComponent(objectId), token, body);
}

export type AdsTargetType = "campaign" | "adset" | "ad";

/**
 * Graph fields readable per object type. Requesting a field an object type
 * does not have (e.g. budgets on an ad, stop_time on an ad set — ad sets
 * call it end_time) makes the Graph API reject the whole read, so each type
 * gets its own field list.
 */
const OBJECT_STATE_FIELDS: Record<AdsTargetType, string> = {
  campaign: "id,name,status,daily_budget,lifetime_budget,start_time,stop_time",
  adset: "id,name,status,daily_budget,lifetime_budget,start_time,end_time,bid_amount,bid_strategy",
  ad: "id,name,status",
};

/** Read the current status/name of any ad object (post-apply verification). */
export async function readObjectState(
  token: string,
  objectId: string,
  targetType: AdsTargetType = "campaign",
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  bidAmount?: number | null;
  bidStrategy?: string | null;
}> {
  const json = await graphGet<RawCampaign>(encodeURIComponent(objectId), token, {
    fields: OBJECT_STATE_FIELDS[targetType] ?? OBJECT_STATE_FIELDS.campaign,
  });
  const base = {
    name: json.name ?? "",
    status: json.status ?? "UNKNOWN",
    dailyBudget: toNum(json.daily_budget),
    lifetimeBudget: toNum(json.lifetime_budget),
    startTime: json.start_time ?? null,
    // Ad sets report end_time; campaigns report stop_time.
    stopTime: json.stop_time ?? json.end_time ?? null,
  };
  if (targetType !== "adset") return base;
  // Bid fields only exist on ad sets; campaigns/ads never carry them so the
  // keys stay absent there (snapshot compare only looks at shared keys).
  return {
    ...base,
    bidAmount: json.bid_amount != null ? toNum(String(json.bid_amount)) : null,
    bidStrategy: json.bid_strategy ?? null,
  };
}
