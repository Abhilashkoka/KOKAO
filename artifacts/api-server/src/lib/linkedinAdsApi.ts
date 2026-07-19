import { platformFetch } from "./platformFetch";

/**
 * LinkedIn Marketing (Advertising) API adapter for the paid-media module.
 *
 * All calls go through the bounded-timeout `platformFetch`; the access token
 * always travels in the Authorization header — never in a URL.
 *
 * Budget normalization: LinkedIn budgets are decimal strings in MAJOR
 * currency units (e.g. "100.50"). Everywhere else in the ads module budgets
 * are integers in MINOR units, so this adapter converts on read (×100) and
 * on write (÷100). That keeps the shared engine snapshot/diff/verify logic
 * and the API schema identical across platforms.
 *
 * Failures throw `LinkedinAdsApiError` with a user-presentable message and
 * an `authFailed` hint (401/403 → token expired, revoked, or the app lacks
 * Advertising API access) so callers can surface a reconnect prompt.
 */

export interface LinkedinAdsCredentials {
  accessToken: string;
  /** Epoch ms when LinkedIn says the token expires (~60 days). */
  expiresAt?: number;
}

export class LinkedinAdsApiError extends Error {
  status: number;
  /** True when the token is expired/revoked or permissions are missing. */
  authFailed: boolean;
  constructor(message: string, status: number, authFailed = false) {
    super(message);
    this.name = "LinkedinAdsApiError";
    this.status = status;
    this.authFailed = authFailed;
  }
}

const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || "202506";

/** Dev/test-only escape hatch so tests can point REST calls at a mock. */
function restBase(): string {
  return (
    (process.env.NODE_ENV !== "production" &&
      process.env.LINKEDIN_ADS_BASE_OVERRIDE) ||
    "https://api.linkedin.com/rest"
  );
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

async function toError(res: Response): Promise<LinkedinAdsApiError> {
  let message = `LinkedIn Ads API error (${res.status})`;
  try {
    const json = (await res.json()) as { message?: string };
    if (json.message) message = json.message;
  } catch {
    // Keep the generic message.
  }
  const authFailed = res.status === 401 || res.status === 403;
  return new LinkedinAdsApiError(message, res.status, authFailed);
}

async function restGet<T>(path: string, token: string): Promise<T> {
  const res = await platformFetch(`${restBase()}/${path}`, {
    headers: baseHeaders(token),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Budget/time normalization
// ---------------------------------------------------------------------------

interface RawMoney {
  amount?: string;
  currencyCode?: string;
}

/** LinkedIn major-unit decimal string → integer minor units. */
function moneyToMinor(m: RawMoney | undefined | null): number | null {
  if (!m?.amount) return null;
  const n = Number(m.amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Integer minor units → LinkedIn major-unit decimal string. */
export function minorToAmount(minor: number): string {
  return (minor / 100).toFixed(2);
}

function msToIso(ms: number | undefined | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isoToMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function accountUrn(adAccountId: string): string {
  return `urn:li:sponsoredAccount:${adAccountId}`;
}

function idFromUrn(urn: string | undefined | null): string | null {
  if (!urn) return null;
  const idx = urn.lastIndexOf(":");
  return idx >= 0 ? urn.slice(idx + 1) : urn;
}

// ---------------------------------------------------------------------------
// Ad accounts
// ---------------------------------------------------------------------------

export interface LinkedinAdAccount {
  adAccountId: string;
  name: string;
  currency: string | null;
  accountStatus: string | null;
}

interface RawAdAccount {
  id?: number | string;
  name?: string;
  currency?: string;
  status?: string;
}

/** List ad accounts the token's member can manage. */
export async function listLinkedinAdAccounts(token: string): Promise<LinkedinAdAccount[]> {
  const json = await restGet<{ elements?: RawAdAccount[] }>(
    "adAccounts?q=search&pageSize=100",
    token,
  );
  return (json.elements ?? []).map((a) => ({
    adAccountId: a.id != null ? String(a.id) : "",
    name: a.name ?? (a.id != null ? String(a.id) : "Ad account"),
    currency: a.currency ?? null,
    accountStatus: a.status ?? null,
  }));
}

/** Verify the token can read the given ad account; returns its name/currency. */
export async function readLinkedinAdAccount(
  token: string,
  adAccountId: string,
): Promise<{ name: string; currency: string | null }> {
  const json = await restGet<RawAdAccount>(
    `adAccounts/${encodeURIComponent(adAccountId)}`,
    token,
  );
  return { name: json.name ?? adAccountId, currency: json.currency ?? null };
}

/**
 * The organization URN the ad account advertises for (`reference`). Sponsored
 * content posts and uploaded images must be owned/authored by this org.
 */
export async function getLinkedinAdAccountReference(
  token: string,
  adAccountId: string,
): Promise<string> {
  const json = await restGet<RawAdAccount & { reference?: string }>(
    `adAccounts/${encodeURIComponent(adAccountId)}`,
    token,
  );
  if (!json.reference) {
    throw new LinkedinAdsApiError(
      "This LinkedIn ad account has no associated organization, so sponsored creatives cannot be created for it.",
      400,
    );
  }
  return json.reference;
}

// ---------------------------------------------------------------------------
// Campaign groups + campaigns
// ---------------------------------------------------------------------------

export interface LinkedinCampaignGroup {
  id: string;
  name: string;
  status: string;
  /** Minor units; groups only carry a total (lifetime) budget. */
  lifetimeBudget: number | null;
}

interface RawCampaignGroup {
  id?: number | string;
  name?: string;
  status?: string;
  totalBudget?: RawMoney;
}

export async function listLinkedinCampaignGroups(
  token: string,
  adAccountId: string,
): Promise<LinkedinCampaignGroup[]> {
  const json = await restGet<{ elements?: RawCampaignGroup[] }>(
    `adAccounts/${encodeURIComponent(adAccountId)}/adCampaignGroups?q=search&pageSize=100`,
    token,
  );
  return (json.elements ?? []).map((g) => ({
    id: g.id != null ? String(g.id) : "",
    name: g.name ?? "",
    status: g.status ?? "UNKNOWN",
    lifetimeBudget: moneyToMinor(g.totalBudget),
  }));
}

export interface LinkedinCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  campaignGroupId: string | null;
  /** Targeted location geo URNs (sorted). */
  targetingLocations: string[];
}

interface RawTargetingCriteria {
  include?: {
    and?: { or?: Record<string, string[]> }[];
  };
}

interface RawCampaign {
  id?: number | string;
  name?: string;
  status?: string;
  objectiveType?: string;
  dailyBudget?: RawMoney;
  totalBudget?: RawMoney;
  runSchedule?: { start?: number; end?: number };
  campaignGroup?: string;
  targetingCriteria?: RawTargetingCriteria;
}

const LOCATIONS_FACET = "urn:li:adTargetingFacet:locations";

/** Extract the targeted location geo URNs (sorted for stable comparison). */
function extractTargetingLocations(tc: RawTargetingCriteria | undefined): string[] {
  const out: string[] = [];
  for (const clause of tc?.include?.and ?? []) {
    const urns = clause.or?.[LOCATIONS_FACET];
    if (Array.isArray(urns)) out.push(...urns);
  }
  return [...new Set(out)].sort();
}

/** Build LinkedIn targetingCriteria that includes the given location URNs. */
function buildTargetingCriteria(locationUrns: string[]): RawTargetingCriteria {
  return {
    include: {
      and: [{ or: { [LOCATIONS_FACET]: locationUrns } }],
    },
  };
}

function mapCampaign(c: RawCampaign): LinkedinCampaign {
  return {
    id: c.id != null ? String(c.id) : "",
    name: c.name ?? "",
    status: c.status ?? "UNKNOWN",
    effectiveStatus: c.status ?? "UNKNOWN",
    objective: c.objectiveType ?? null,
    dailyBudget: moneyToMinor(c.dailyBudget),
    lifetimeBudget: moneyToMinor(c.totalBudget),
    startTime: msToIso(c.runSchedule?.start),
    stopTime: msToIso(c.runSchedule?.end),
    campaignGroupId: idFromUrn(c.campaignGroup),
    targetingLocations: extractTargetingLocations(c.targetingCriteria),
  };
}

export async function listLinkedinCampaigns(
  token: string,
  adAccountId: string,
): Promise<LinkedinCampaign[]> {
  const json = await restGet<{ elements?: RawCampaign[] }>(
    `adAccounts/${encodeURIComponent(adAccountId)}/adCampaigns?q=search&pageSize=100`,
    token,
  );
  return (json.elements ?? []).map(mapCampaign);
}

export async function getLinkedinCampaign(
  token: string,
  adAccountId: string,
  campaignId: string,
): Promise<LinkedinCampaign> {
  const json = await restGet<RawCampaign>(
    `adAccounts/${encodeURIComponent(adAccountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
    token,
  );
  return mapCampaign(json);
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface LinkedinMetrics {
  impressions: number;
  clicks: number;
  ctr: number;
  spend: number;
  results: number;
}

import type { AdsDatePreset } from "./metaAdsApi";

function presetToRange(preset: AdsDatePreset): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date(end);
  switch (preset) {
    case "today":
      break;
    case "yesterday":
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case "last_7d":
      start.setDate(start.getDate() - 7);
      break;
    case "last_14d":
      start.setDate(start.getDate() - 14);
      break;
    case "last_30d":
      start.setDate(start.getDate() - 30);
      break;
    case "last_90d":
      start.setDate(start.getDate() - 90);
      break;
    case "maximum":
      start.setFullYear(start.getFullYear() - 10);
      break;
  }
  return { start, end };
}

function dateParam(d: Date): string {
  // Restli 2.0 structured date: (day:D,month:M,year:Y)
  return `(day:${d.getUTCDate()},month:${d.getUTCMonth() + 1},year:${d.getUTCFullYear()})`;
}

interface RawAnalyticsRow {
  pivotValues?: string[];
  impressions?: number;
  clicks?: number;
  costInLocalCurrency?: string;
  externalWebsiteConversions?: number;
}

/**
 * Fetch account-wide analytics at the given pivot, keyed by the pivoted
 * object's id. Objects with no delivery simply have no row.
 */
export async function getLinkedinAnalytics(
  token: string,
  adAccountId: string,
  pivot: "CAMPAIGN" | "CAMPAIGN_GROUP",
  datePreset: AdsDatePreset,
): Promise<Map<string, LinkedinMetrics>> {
  const { start, end } = presetToRange(datePreset);
  const urn = encodeURIComponent(accountUrn(adAccountId));
  const qs =
    `q=analytics&pivot=${pivot}&timeGranularity=ALL` +
    `&dateRange=(start:${dateParam(start)},end:${dateParam(end)})` +
    `&accounts=List(${urn})` +
    `&fields=pivotValues,impressions,clicks,costInLocalCurrency,externalWebsiteConversions`;
  const json = await restGet<{ elements?: RawAnalyticsRow[] }>(
    `adAnalytics?${qs}`,
    token,
  );
  const map = new Map<string, LinkedinMetrics>();
  for (const row of json.elements ?? []) {
    const id = idFromUrn(row.pivotValues?.[0]);
    if (!id) continue;
    const impressions = row.impressions ?? 0;
    const clicks = row.clicks ?? 0;
    const spend = Number(row.costInLocalCurrency ?? "0");
    map.set(id, {
      impressions,
      clicks,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      spend: Number.isFinite(spend) ? spend : 0,
      results: row.externalWebsiteConversions ?? 0,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Writes (create + partial update) and state read-back
// ---------------------------------------------------------------------------

export interface CreateLinkedinCampaignParams {
  name: string;
  campaignGroupId: string;
  status: "ACTIVE" | "PAUSED";
  /** Minor units; converted to LinkedIn's major-unit decimal string. */
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
  currency: string;
  /** Location geo URNs; defaults to worldwide when omitted/empty. */
  targetingLocations?: string[] | null;
}

/** Create a campaign in the given group; returns the new campaign id. */
export async function createLinkedinCampaign(
  token: string,
  adAccountId: string,
  params: CreateLinkedinCampaignParams,
): Promise<string> {
  const runSchedule: Record<string, number> = {};
  const startMs = params.startTime ? isoToMs(params.startTime) : null;
  const endMs = params.stopTime ? isoToMs(params.stopTime) : null;
  runSchedule.start = startMs ?? Date.now();
  if (endMs != null) runSchedule.end = endMs;

  const body: Record<string, unknown> = {
    account: accountUrn(adAccountId),
    campaignGroup: `urn:li:sponsoredCampaignGroup:${params.campaignGroupId}`,
    name: params.name,
    status: params.status,
    type: "SPONSORED_UPDATES",
    costType: "CPM",
    unitCost: { amount: "0", currencyCode: params.currency },
    runSchedule,
    locale: { country: "US", language: "en" },
    // Location targeting is required for a campaign to be valid; default to
    // worldwide when the draft does not specify locations.
    targetingCriteria: buildTargetingCriteria(
      params.targetingLocations?.length
        ? params.targetingLocations
        : ["urn:li:geo:92000000"],
    ),
  };
  if (params.dailyBudget != null) {
    body.dailyBudget = {
      amount: minorToAmount(params.dailyBudget),
      currencyCode: params.currency,
    };
  }
  if (params.lifetimeBudget != null) {
    body.totalBudget = {
      amount: minorToAmount(params.lifetimeBudget),
      currencyCode: params.currency,
    };
  }

  const res = await platformFetch(
    `${restBase()}/adAccounts/${encodeURIComponent(adAccountId)}/adCampaigns`,
    {
      method: "POST",
      headers: { ...baseHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await toError(res);
  const created = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (created) return created;
  try {
    const json = (await res.json()) as { id?: number | string };
    if (json.id != null) return String(json.id);
  } catch {
    // Fall through.
  }
  throw new LinkedinAdsApiError("LinkedIn did not return a campaign id.", 502);
}

export interface CreateLinkedinCampaignGroupParams {
  name: string;
  status: "ACTIVE" | "PAUSED";
  /** Minor units; groups only support a total (lifetime) budget. */
  lifetimeBudget?: number | null;
  currency: string;
}

/** Create a campaign group; returns the new group id. */
export async function createLinkedinCampaignGroup(
  token: string,
  adAccountId: string,
  params: CreateLinkedinCampaignGroupParams,
): Promise<string> {
  const body: Record<string, unknown> = {
    account: accountUrn(adAccountId),
    name: params.name,
    status: params.status,
    // LinkedIn requires a schedule start on group creation.
    runSchedule: { start: Date.now() },
  };
  if (params.lifetimeBudget != null) {
    body.totalBudget = {
      amount: minorToAmount(params.lifetimeBudget),
      currencyCode: params.currency,
    };
  }
  const res = await platformFetch(
    `${restBase()}/adAccounts/${encodeURIComponent(adAccountId)}/adCampaignGroups`,
    {
      method: "POST",
      headers: { ...baseHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await toError(res);
  const created = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (created) return created;
  try {
    const json = (await res.json()) as { id?: number | string };
    if (json.id != null) return String(json.id);
  } catch {
    // Fall through.
  }
  throw new LinkedinAdsApiError("LinkedIn did not return a campaign group id.", 502);
}

/**
 * Read the current campaign-group state in the engine's shared snapshot
 * shape (drift check + post-apply verification). Groups have no daily
 * budget; their total budget maps to lifetimeBudget in minor units.
 */
export async function readLinkedinCampaignGroupState(
  token: string,
  adAccountId: string,
  groupId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}> {
  const json = await restGet<{
    name?: string;
    status?: string;
    totalBudget?: RawMoney;
    runSchedule?: { start?: number; end?: number };
  }>(
    `adAccounts/${encodeURIComponent(adAccountId)}/adCampaignGroups/${encodeURIComponent(groupId)}`,
    token,
  );
  return {
    name: json.name ?? "",
    status: json.status ?? "UNKNOWN",
    dailyBudget: null,
    lifetimeBudget: moneyToMinor(json.totalBudget),
    startTime: msToIso(json.runSchedule?.start),
    stopTime: msToIso(json.runSchedule?.end),
  };
}

export interface UpdateLinkedinCampaignGroupParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  /** Minor units; groups only support a total (lifetime) budget. */
  lifetimeBudget?: number | null;
  currency: string;
}

/** Partial-update a campaign group in place (Restli PARTIAL_UPDATE with $set). */
export async function updateLinkedinCampaignGroup(
  token: string,
  adAccountId: string,
  groupId: string,
  params: UpdateLinkedinCampaignGroupParams,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (params.name != null) set.name = params.name;
  if (params.status != null) set.status = params.status;
  if (params.lifetimeBudget != null) {
    set.totalBudget = {
      amount: minorToAmount(params.lifetimeBudget),
      currencyCode: params.currency,
    };
  }

  const res = await platformFetch(
    `${restBase()}/adAccounts/${encodeURIComponent(adAccountId)}/adCampaignGroups/${encodeURIComponent(groupId)}`,
    {
      method: "POST",
      headers: {
        ...baseHeaders(token),
        "Content-Type": "application/json",
        "X-RestLi-Method": "PARTIAL_UPDATE",
      },
      body: JSON.stringify({ patch: { $set: set } }),
    },
  );
  if (!res.ok) throw await toError(res);
}

export interface UpdateLinkedinCampaignParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  /** Minor units. */
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
  currency: string;
  /** Replace location targeting with these geo URNs (must be non-empty). */
  targetingLocations?: string[] | null;
}

/** Partial-update a campaign in place (Restli PARTIAL_UPDATE with $set). */
export async function updateLinkedinCampaign(
  token: string,
  adAccountId: string,
  campaignId: string,
  params: UpdateLinkedinCampaignParams,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (params.name != null) set.name = params.name;
  if (params.status != null) set.status = params.status;
  if (params.dailyBudget != null) {
    set.dailyBudget = {
      amount: minorToAmount(params.dailyBudget),
      currencyCode: params.currency,
    };
  }
  if (params.lifetimeBudget != null) {
    set.totalBudget = {
      amount: minorToAmount(params.lifetimeBudget),
      currencyCode: params.currency,
    };
  }
  if (params.startTime != null || params.stopTime != null) {
    const runSchedule: Record<string, number> = {};
    const startMs = params.startTime ? isoToMs(params.startTime) : null;
    const endMs = params.stopTime ? isoToMs(params.stopTime) : null;
    if (startMs != null) runSchedule.start = startMs;
    if (endMs != null) runSchedule.end = endMs;
    set.runSchedule = runSchedule;
  }
  if (params.targetingLocations != null && params.targetingLocations.length > 0) {
    set.targetingCriteria = buildTargetingCriteria(params.targetingLocations);
  }

  const res = await platformFetch(
    `${restBase()}/adAccounts/${encodeURIComponent(adAccountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
    {
      method: "POST",
      headers: {
        ...baseHeaders(token),
        "Content-Type": "application/json",
        "X-RestLi-Method": "PARTIAL_UPDATE",
      },
      body: JSON.stringify({ patch: { $set: set } }),
    },
  );
  if (!res.ok) throw await toError(res);
}

/**
 * Read the current campaign state in the engine's shared snapshot shape
 * (drift check + post-apply verification). Budgets come back in minor units.
 */
export async function readLinkedinCampaignState(
  token: string,
  adAccountId: string,
  campaignId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  targetingLocations: string[];
}> {
  const c = await getLinkedinCampaign(token, adAccountId, campaignId);
  return {
    name: c.name,
    status: c.status,
    dailyBudget: c.dailyBudget,
    lifetimeBudget: c.lifetimeBudget,
    startTime: c.startTime,
    stopTime: c.stopTime,
    targetingLocations: c.targetingLocations,
  };
}

// ---------------------------------------------------------------------------
// Geo targeting typeahead
// ---------------------------------------------------------------------------

interface RawTargetingEntity {
  urn?: string;
  name?: string;
}

/** Typeahead search for location targeting entities (geo URNs). */
export async function searchLinkedinGeoLocations(
  token: string,
  query: string,
): Promise<{ urn: string; name: string }[]> {
  const qs =
    `q=typeahead&queryVersion=QUERY_USES_URNS` +
    `&facet=${encodeURIComponent(LOCATIONS_FACET)}` +
    `&query=${encodeURIComponent(query)}`;
  const json = await restGet<{ elements?: RawTargetingEntity[] }>(
    `adTargetingEntities?${qs}`,
    token,
  );
  return (json.elements ?? [])
    .filter((e) => !!e.urn && !!e.name)
    .map((e) => ({ urn: e.urn!, name: e.name! }))
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Creatives (sponsored content: upload image -> dark post -> creative)
// ---------------------------------------------------------------------------

/**
 * Upload an image owned by the given organization; returns the image URN.
 * Two steps: initializeUpload for a signed URL, then a raw PUT of the bytes.
 */
export async function uploadLinkedinAdImage(
  token: string,
  ownerUrn: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const initRes = await platformFetch(
    `${restBase()}/images?action=initializeUpload`,
    {
      method: "POST",
      headers: { ...baseHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    },
  );
  if (!initRes.ok) throw await toError(initRes);
  const initJson = (await initRes.json()) as {
    value?: { uploadUrl?: string; image?: string };
  };
  const uploadUrl = initJson.value?.uploadUrl;
  const imageUrn = initJson.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new LinkedinAdsApiError(
      "LinkedIn did not return an image upload URL.",
      502,
    );
  }
  const putRes = await platformFetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType || "application/octet-stream",
    },
    body: new Uint8Array(bytes),
  });
  if (!putRes.ok) {
    throw new LinkedinAdsApiError(
      `LinkedIn image upload failed (HTTP ${putRes.status}).`,
      putRes.status,
    );
  }
  return imageUrn;
}

/**
 * Create a sponsored-content ("dark") post authored by the organization.
 * Returns the post URN. `imageUrn` is optional (text-only sponsored post).
 */
export async function createLinkedinAdPost(
  token: string,
  authorUrn: string,
  text: string,
  imageUrn?: string | null,
  landingUrl?: string | null,
): Promise<string> {
  const body: Record<string, unknown> = {
    author: authorUrn,
    commentary: text,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "NONE",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    adContext: { dscStatus: "ACTIVE", dscName: text.slice(0, 100) || "Sponsored post" },
  };
  if (imageUrn) {
    body.content = {
      media: { id: imageUrn, ...(landingUrl ? { landingPage: landingUrl } : {}) },
    };
  } else if (landingUrl) {
    body.content = { article: { source: landingUrl } };
  }
  const res = await platformFetch(`${restBase()}/posts`, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  const postUrn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!postUrn) {
    throw new LinkedinAdsApiError("LinkedIn did not return a post id.", 502);
  }
  return postUrn;
}

/**
 * Attach the sponsored post to a campaign as a creative; returns the creative
 * id (numeric part of the sponsoredCreative URN when available).
 */
export async function createLinkedinCreative(
  token: string,
  adAccountId: string,
  campaignId: string,
  postUrn: string,
  status: "ACTIVE" | "PAUSED",
): Promise<string> {
  const res = await platformFetch(
    `${restBase()}/adAccounts/${encodeURIComponent(adAccountId)}/creatives`,
    {
      method: "POST",
      headers: { ...baseHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign: `urn:li:sponsoredCampaign:${campaignId}`,
        content: { reference: postUrn },
        intendedStatus: status,
      }),
    },
  );
  if (!res.ok) throw await toError(res);
  const created = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!created) {
    throw new LinkedinAdsApiError("LinkedIn did not return a creative id.", 502);
  }
  return idFromUrn(created) ?? created;
}

interface RawCreative {
  id?: string;
  intendedStatus?: string;
  isServing?: boolean;
  review?: { status?: string };
  campaign?: string;
  content?: { reference?: string };
}

export interface LinkedinCreative {
  id: string;
  status: string;
  reviewStatus: string | null;
  campaignId: string | null;
  postUrn: string | null;
}

function mapCreative(c: RawCreative): LinkedinCreative {
  return {
    id: idFromUrn(c.id) ?? (c.id != null ? String(c.id) : ""),
    status: c.intendedStatus ?? "UNKNOWN",
    reviewStatus: c.review?.status ?? null,
    campaignId: idFromUrn(c.campaign),
    postUrn: c.content?.reference ?? null,
  };
}

/** Read one creative in the engine's snapshot-compatible shape. */
export async function readLinkedinCreativeState(
  token: string,
  adAccountId: string,
  creativeId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}> {
  const urn = `urn:li:sponsoredCreative:${creativeId}`;
  const json = await restGet<RawCreative>(
    `adAccounts/${encodeURIComponent(adAccountId)}/creatives/${encodeURIComponent(urn)}`,
    token,
  );
  const c = mapCreative(json);
  return {
    name: c.postUrn ?? c.id,
    status: c.status,
    dailyBudget: null,
    lifetimeBudget: null,
    startTime: null,
    stopTime: null,
  };
}

/** List the creatives attached to a campaign. */
export async function listLinkedinCreatives(
  token: string,
  adAccountId: string,
  campaignId: string,
): Promise<LinkedinCreative[]> {
  const campaignUrn = encodeURIComponent(
    `urn:li:sponsoredCampaign:${campaignId}`,
  );
  const json = await restGet<{ elements?: RawCreative[] }>(
    `adAccounts/${encodeURIComponent(adAccountId)}/creatives?q=criteria&campaigns=List(${campaignUrn})&pageSize=100`,
    token,
  );
  return (json.elements ?? []).map(mapCreative);
}
