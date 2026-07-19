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

// ---------------------------------------------------------------------------
// Campaign groups + campaigns
// ---------------------------------------------------------------------------

export interface LinkedinCampaignGroup {
  id: string;
  name: string;
  status: string;
}

interface RawCampaignGroup {
  id?: number | string;
  name?: string;
  status?: string;
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
    // Minimal worldwide targeting so the campaign is valid; advertisers
    // refine targeting in Campaign Manager (targeting is out of scope here).
    targetingCriteria: {
      include: {
        and: [
          {
            or: {
              "urn:li:adTargetingFacet:locations": ["urn:li:geo:92000000"],
            },
          },
        ],
      },
    },
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

export interface UpdateLinkedinCampaignParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  /** Minor units. */
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
  currency: string;
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
}> {
  const c = await getLinkedinCampaign(token, adAccountId, campaignId);
  return {
    name: c.name,
    status: c.status,
    dailyBudget: c.dailyBudget,
    lifetimeBudget: c.lifetimeBudget,
    startTime: c.startTime,
    stopTime: c.stopTime,
  };
}
