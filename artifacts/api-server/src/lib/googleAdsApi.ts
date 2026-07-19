import {
  db,
  appCredentialsTable,
  adAccountConnectionsTable,
  type AdAccountConnection,
  type GoogleAdsAppCredentials,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "./secretCrypto";
import { platformFetch } from "./platformFetch";

/**
 * Google Ads API adapter for the paid-media module.
 *
 * All calls go through the bounded-timeout `platformFetch`. Secrets travel in
 * headers or POST bodies, never URLs. Access tokens are short-lived; the
 * long-lived refresh token is stored encrypted on the connection row and
 * `getGoogleAdsAuth` refreshes the access token automatically, persisting the
 * new one back to the row. A dead refresh token (revoked grant) throws with
 * `authFailed: true` so callers surface a reconnect prompt.
 *
 * Unit conventions: Google budgets/costs are in MICROS (1e-6 of a currency
 * unit). The shared ads engine speaks minor units (1e-2), so this adapter
 * converts at the boundary (minor = micros / 10,000). Campaign statuses are
 * mapped between Google's ENABLED and the shared vocabulary's ACTIVE.
 */

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v21";

/** Dev/test-only escape hatches so tests can point calls at a mock. */
function googleAdsBase(): string {
  return (
    (process.env.NODE_ENV !== "production" &&
      process.env.GOOGLE_ADS_API_BASE_OVERRIDE) ||
    "https://googleads.googleapis.com"
  );
}

function googleTokenUrl(): string {
  return (
    (process.env.NODE_ENV !== "production" &&
      process.env.GOOGLE_ADS_TOKEN_URL_OVERRIDE) ||
    "https://oauth2.googleapis.com/token"
  );
}

// ---------------------------------------------------------------------------
// App-level credentials (superadmin-managed, encrypted in app_credentials)
// ---------------------------------------------------------------------------

export const GOOGLE_ADS_CREDENTIALS_PROVIDER = "google_ads";

export async function getGoogleAdsAppCredentials(): Promise<GoogleAdsAppCredentials | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, GOOGLE_ADS_CREDENTIALS_PROVIDER))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<GoogleAdsAppCredentials>(row.encryptedCredentials);
    if (!creds.clientId || !creds.clientSecret || !creds.developerToken) return null;
    return creds;
  } catch {
    return null;
  }
}

export async function isGoogleAdsConfigured(): Promise<boolean> {
  return (await getGoogleAdsAppCredentials()) != null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GoogleAdsApiError extends Error {
  status: number;
  /** True when the grant is expired/revoked or permissions are missing. */
  authFailed: boolean;
  constructor(message: string, status: number, authFailed = false) {
    super(message);
    this.name = "GoogleAdsApiError";
    this.status = status;
    this.authFailed = authFailed;
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: {
      errors?: { message?: string; errorCode?: Record<string, string> }[];
    }[];
  };
  error_description?: string;
}

function toApiError(json: GoogleErrorBody, httpStatus: number): GoogleAdsApiError {
  const detail = json.error?.details?.flatMap((d) => d.errors ?? [])[0]?.message;
  const message =
    detail || json.error?.message || json.error_description || `Google Ads API error (${httpStatus})`;
  const authFailed =
    httpStatus === 401 ||
    httpStatus === 403 ||
    json.error?.status === "UNAUTHENTICATED" ||
    json.error?.status === "PERMISSION_DENIED";
  return new GoogleAdsApiError(message, httpStatus, authFailed);
}

// ---------------------------------------------------------------------------
// OAuth: authorization URL, code exchange, refresh
// ---------------------------------------------------------------------------

export function buildGoogleAdsAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_ADS_SCOPE,
    access_type: "offline",
    // Force the consent screen so Google always returns a refresh token,
    // even on re-connects.
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await platformFetch(googleTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    const authFailed = json.error === "invalid_grant" || res.status === 401;
    throw new GoogleAdsApiError(
      json.error_description || json.error || `Google token request failed (${res.status})`,
      res.status,
      authFailed,
    );
  }
  return json;
}

export async function exchangeGoogleAdsCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const creds = await getGoogleAdsAppCredentials();
  if (!creds) throw new GoogleAdsApiError("Google Ads is not configured.", 503);
  const json = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
    }),
  );
  return {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in ?? 3600,
  };
}

export async function refreshGoogleAdsAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const creds = await getGoogleAdsAppCredentials();
  if (!creds) throw new GoogleAdsApiError("Google Ads is not configured.", 503);
  const json = await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  );
  return { accessToken: json.access_token!, expiresIn: json.expires_in ?? 3600 };
}

// ---------------------------------------------------------------------------
// Per-tenant connection credentials + automatic token refresh
// ---------------------------------------------------------------------------

/** Stored encrypted on the ad connection row. */
export interface GoogleAdsCredentials {
  refreshToken: string;
  accessToken?: string;
  /** ISO timestamp when `accessToken` expires. */
  accessTokenExpiresAt?: string;
  /** Manager (MCC) customer id required to act on a client account. */
  loginCustomerId?: string | null;
}

/** Everything a Google Ads API call needs. */
export interface GoogleAdsAuth {
  accessToken: string;
  developerToken: string;
  /** The operating customer id (digits only). */
  customerId: string;
  loginCustomerId: string | null;
}

/** Refresh at least a minute before actual expiry. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export function normalizeCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

/**
 * Resolve a ready-to-use auth context for a Google ad connection, refreshing
 * the access token when missing/expired and persisting it back to the row.
 * Throws GoogleAdsApiError (authFailed when the grant is revoked).
 */
export async function getGoogleAdsAuth(
  conn: AdAccountConnection,
): Promise<GoogleAdsAuth> {
  const appCreds = await getGoogleAdsAppCredentials();
  if (!appCreds) throw new GoogleAdsApiError("Google Ads is not configured.", 503);
  if (!conn.encryptedCredentials) {
    throw new GoogleAdsApiError("The Google Ads connection has no stored credentials.", 401, true);
  }
  let stored: GoogleAdsCredentials;
  try {
    stored = decryptJson<GoogleAdsCredentials>(conn.encryptedCredentials);
  } catch {
    throw new GoogleAdsApiError("The stored Google Ads credentials could not be read.", 401, true);
  }
  if (!stored.refreshToken) {
    throw new GoogleAdsApiError("The Google Ads connection is missing its refresh token.", 401, true);
  }

  let accessToken = stored.accessToken ?? null;
  const expiresAt = stored.accessTokenExpiresAt
    ? Date.parse(stored.accessTokenExpiresAt)
    : NaN;
  const fresh =
    accessToken != null &&
    Number.isFinite(expiresAt) &&
    expiresAt - TOKEN_EXPIRY_SLACK_MS > Date.now();

  if (!fresh) {
    const refreshed = await refreshGoogleAdsAccessToken(stored.refreshToken);
    accessToken = refreshed.accessToken;
    const next: GoogleAdsCredentials = {
      ...stored,
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: new Date(
        Date.now() + refreshed.expiresIn * 1000,
      ).toISOString(),
    };
    await db
      .update(adAccountConnectionsTable)
      .set({ encryptedCredentials: encryptJson(next), updatedAt: new Date() })
      .where(eq(adAccountConnectionsTable.id, conn.id));
  }

  return {
    accessToken: accessToken!,
    developerToken: appCreds.developerToken,
    customerId: normalizeCustomerId(conn.adAccountId || ""),
    loginCustomerId: stored.loginCustomerId
      ? normalizeCustomerId(stored.loginCustomerId)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Low-level REST helpers
// ---------------------------------------------------------------------------

function adsHeaders(auth: {
  accessToken: string;
  developerToken: string;
  loginCustomerId?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "developer-token": auth.developerToken,
    "Content-Type": "application/json",
  };
  if (auth.loginCustomerId) headers["login-customer-id"] = auth.loginCustomerId;
  return headers;
}

async function adsRequest<T>(
  path: string,
  auth: { accessToken: string; developerToken: string; loginCustomerId?: string | null },
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await platformFetch(
    `${googleAdsBase()}/${GOOGLE_ADS_API_VERSION}/${path}`,
    {
      method: init?.method ?? "GET",
      headers: adsHeaders(auth),
      body: init?.body != null ? JSON.stringify(init.body) : undefined,
    },
  );
  const json = (await res.json().catch(() => ({}))) as T & GoogleErrorBody;
  if (!res.ok || json.error) throw toApiError(json, res.status);
  return json;
}

interface SearchResult<Row> {
  results?: Row[];
  nextPageToken?: string;
}

/** Run a GAQL query against a customer (single page, capped). */
async function gaqlSearch<Row>(
  auth: GoogleAdsAuth,
  query: string,
  customerId: string = auth.customerId,
): Promise<Row[]> {
  const json = await adsRequest<SearchResult<Row>>(
    `customers/${encodeURIComponent(customerId)}/googleAds:search`,
    auth,
    { method: "POST", body: { query, pageSize: 500 } },
  );
  return json.results ?? [];
}

// ---------------------------------------------------------------------------
// Customer discovery (incl. MCC manager account hierarchies)
// ---------------------------------------------------------------------------

export interface GoogleAdsCustomerChoice {
  /** Digits-only customer id of the pickable account. */
  customerId: string;
  name: string;
  currency: string | null;
  /** True when the account itself is a manager (MCC) account. */
  manager: boolean;
  /**
   * Manager id to send as login-customer-id when operating on this account,
   * or null when it is directly accessible.
   */
  loginCustomerId: string | null;
}

/** Ids of customers the grant can access directly. */
export async function listAccessibleCustomers(auth: {
  accessToken: string;
  developerToken: string;
}): Promise<string[]> {
  const json = await adsRequest<{ resourceNames?: string[] }>(
    "customers:listAccessibleCustomers",
    auth,
  );
  return (json.resourceNames ?? [])
    .map((r) => r.replace(/^customers\//, ""))
    .filter(Boolean);
}

interface CustomerClientRow {
  customerClient?: {
    id?: string;
    descriptiveName?: string;
    currencyCode?: string;
    manager?: boolean;
    level?: string | number;
    status?: string;
  };
}

/**
 * List the ad accounts pickable with this grant: every directly accessible
 * customer plus, for manager (MCC) accounts, their client accounts (with the
 * manager recorded as the login customer).
 */
export async function listCustomerChoices(auth: {
  accessToken: string;
  developerToken: string;
}): Promise<GoogleAdsCustomerChoice[]> {
  const roots = await listAccessibleCustomers(auth);
  const choices = new Map<string, GoogleAdsCustomerChoice>();
  for (const root of roots) {
    const rootId = normalizeCustomerId(root);
    let rows: CustomerClientRow[];
    try {
      rows = await gaqlSearch<CustomerClientRow>(
        {
          ...auth,
          customerId: rootId,
          loginCustomerId: rootId,
        },
        "SELECT customer_client.id, customer_client.descriptive_name, " +
          "customer_client.currency_code, customer_client.manager, " +
          "customer_client.level, customer_client.status " +
          "FROM customer_client WHERE customer_client.level <= 1 " +
          "AND customer_client.status = 'ENABLED'",
        rootId,
      );
    } catch {
      // Cancelled/inaccessible accounts throw; skip them rather than failing
      // the whole listing.
      continue;
    }
    for (const row of rows) {
      const c = row.customerClient;
      if (!c?.id) continue;
      const id = normalizeCustomerId(String(c.id));
      const isSelf = id === rootId;
      const choice: GoogleAdsCustomerChoice = {
        customerId: id,
        name: c.descriptiveName || `Account ${id}`,
        currency: c.currencyCode ?? null,
        manager: c.manager === true,
        loginCustomerId: isSelf ? null : rootId,
      };
      // Prefer a directly accessible entry over one seen through a manager.
      const existing = choices.get(id);
      if (!existing || (existing.loginCustomerId && !choice.loginCustomerId)) {
        choices.set(id, choice);
      }
    }
  }
  return [...choices.values()];
}

/** Verify the grant can read the given customer; returns name/currency. */
export async function readCustomer(
  auth: GoogleAdsAuth,
): Promise<{ name: string; currency: string | null }> {
  const rows = await gaqlSearch<{
    customer?: { id?: string; descriptiveName?: string; currencyCode?: string };
  }>(
    auth,
    "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer",
  );
  const c = rows[0]?.customer;
  return {
    name: c?.descriptiveName || `Account ${auth.customerId}`,
    currency: c?.currencyCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// Unit and status mapping
// ---------------------------------------------------------------------------

export function microsToMinor(micros: number | null | undefined): number | null {
  if (micros == null || !Number.isFinite(Number(micros))) return null;
  return Math.round(Number(micros) / 10_000);
}

export function minorToMicros(minor: number): number {
  return Math.round(minor * 10_000);
}

/** Google campaign status → shared vocabulary. */
function statusToShared(status: string | undefined): string {
  if (status === "ENABLED") return "ACTIVE";
  return status ?? "UNKNOWN";
}

/** Shared vocabulary → Google campaign status. */
function statusToGoogle(status: string): string {
  if (status === "ACTIVE") return "ENABLED";
  return status;
}

/** Google schedule fields are plain dates (YYYY-MM-DD). */
function toGoogleDate(value: string): string {
  return value.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface GoogleAdsMetrics {
  impressions: number;
  clicks: number;
  ctr: number;
  spend: number;
  results: number;
}

interface RawMetrics {
  impressions?: string | number;
  clicks?: string | number;
  ctr?: string | number;
  costMicros?: string | number;
  conversions?: string | number;
}

function num(v: string | number | undefined | null): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapMetrics(m: RawMetrics | undefined): GoogleAdsMetrics {
  return {
    impressions: num(m?.impressions),
    clicks: num(m?.clicks),
    // Google reports CTR as a fraction; the shared shape uses percent.
    ctr: num(m?.ctr) * 100,
    // Spend in major currency units, matching the shared metrics shape.
    spend: num(m?.costMicros) / 1_000_000,
    results: num(m?.conversions),
  };
}

import type { AdsDatePreset } from "./metaAdsApi";

function dateClause(preset: AdsDatePreset): string {
  switch (preset) {
    case "today":
      return " WHERE segments.date DURING TODAY";
    case "yesterday":
      return " WHERE segments.date DURING YESTERDAY";
    case "last_7d":
      return " WHERE segments.date DURING LAST_7_DAYS";
    case "last_14d":
      return " WHERE segments.date DURING LAST_14_DAYS";
    case "last_30d":
      return " WHERE segments.date DURING LAST_30_DAYS";
    case "last_90d": {
      const end = new Date();
      const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      return ` WHERE segments.date BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
    }
    case "maximum":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Campaign reads
// ---------------------------------------------------------------------------

export interface GoogleCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
  metrics: GoogleAdsMetrics;
}

interface RawCampaignRow {
  campaign?: {
    id?: string | number;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    startDate?: string;
    endDate?: string;
    campaignBudget?: string;
  };
  campaignBudget?: { amountMicros?: string | number; resourceName?: string };
  metrics?: RawMetrics;
}

function mapCampaignRow(row: RawCampaignRow): GoogleCampaign {
  const c = row.campaign ?? {};
  const shared = statusToShared(c.status);
  return {
    id: c.id != null ? String(c.id) : "",
    name: c.name ?? "",
    status: shared,
    effectiveStatus: shared,
    objective: c.advertisingChannelType ?? null,
    dailyBudget: microsToMinor(num(row.campaignBudget?.amountMicros) || null),
    lifetimeBudget: null,
    startTime: c.startDate ?? null,
    stopTime: c.endDate ?? null,
    metrics: mapMetrics(row.metrics),
  };
}

const CAMPAIGN_SELECT =
  "SELECT campaign.id, campaign.name, campaign.status, " +
  "campaign.advertising_channel_type, campaign.start_date, campaign.end_date, " +
  "campaign.campaign_budget, campaign_budget.amount_micros, " +
  "metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, " +
  "metrics.conversions FROM campaign";

export async function listGoogleCampaigns(
  auth: GoogleAdsAuth,
  datePreset: AdsDatePreset,
): Promise<GoogleCampaign[]> {
  const rows = await gaqlSearch<RawCampaignRow>(
    auth,
    `${CAMPAIGN_SELECT}${dateClause(datePreset)}`,
  );
  return rows.map(mapCampaignRow).filter((c) => c.id);
}

export async function getGoogleCampaign(
  auth: GoogleAdsAuth,
  campaignId: string,
  datePreset: AdsDatePreset,
): Promise<GoogleCampaign | null> {
  const clause = dateClause(datePreset);
  const cond = `campaign.id = ${Number(campaignId)}`;
  const query = clause
    ? `${CAMPAIGN_SELECT}${clause} AND ${cond}`
    : `${CAMPAIGN_SELECT} WHERE ${cond}`;
  const rows = await gaqlSearch<RawCampaignRow>(auth, query);
  const mapped = rows.map(mapCampaignRow).filter((c) => c.id);
  if (mapped.length > 0) return mapped[0]!;
  // Metrics-filtered queries can drop campaigns with no delivery; re-read
  // without the date clause so the campaign itself is still found.
  if (clause) {
    const bare = await gaqlSearch<RawCampaignRow>(
      auth,
      `${CAMPAIGN_SELECT} WHERE ${cond}`,
    );
    return bare.map(mapCampaignRow).find((c) => c.id) ?? null;
  }
  return null;
}

export interface GoogleAdGroup {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  metrics: GoogleAdsMetrics;
}

export async function listGoogleAdGroups(
  auth: GoogleAdsAuth,
  campaignId: string,
  datePreset: AdsDatePreset,
): Promise<GoogleAdGroup[]> {
  const clause = dateClause(datePreset);
  const cond = `campaign.id = ${Number(campaignId)}`;
  const query =
    "SELECT ad_group.id, ad_group.name, ad_group.status, " +
    "metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, " +
    "metrics.conversions FROM ad_group" +
    (clause ? `${clause} AND ${cond}` : ` WHERE ${cond}`);
  const rows = await gaqlSearch<{
    adGroup?: { id?: string | number; name?: string; status?: string };
    metrics?: RawMetrics;
  }>(auth, query);
  return rows
    .filter((r) => r.adGroup?.id != null)
    .map((r) => ({
      id: String(r.adGroup!.id),
      name: r.adGroup!.name ?? "",
      status: statusToShared(r.adGroup!.status),
      effectiveStatus: statusToShared(r.adGroup!.status),
      dailyBudget: null,
      lifetimeBudget: null,
      metrics: mapMetrics(r.metrics),
    }));
}

export interface GoogleAdRow {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  adSetId: string | null;
  metrics: GoogleAdsMetrics;
}

export async function listGoogleAds(
  auth: GoogleAdsAuth,
  campaignId: string,
  datePreset: AdsDatePreset,
): Promise<GoogleAdRow[]> {
  const clause = dateClause(datePreset);
  const cond = `campaign.id = ${Number(campaignId)}`;
  const query =
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, " +
    "ad_group.id, metrics.impressions, metrics.clicks, metrics.ctr, " +
    "metrics.cost_micros, metrics.conversions FROM ad_group_ad" +
    (clause ? `${clause} AND ${cond}` : ` WHERE ${cond}`);
  const rows = await gaqlSearch<{
    adGroupAd?: { status?: string; ad?: { id?: string | number; name?: string } };
    adGroup?: { id?: string | number };
    metrics?: RawMetrics;
  }>(auth, query);
  return rows
    .filter((r) => r.adGroupAd?.ad?.id != null)
    .map((r) => ({
      id: String(r.adGroupAd!.ad!.id),
      name: r.adGroupAd!.ad!.name || `Ad ${r.adGroupAd!.ad!.id}`,
      status: statusToShared(r.adGroupAd!.status),
      effectiveStatus: statusToShared(r.adGroupAd!.status),
      adSetId: r.adGroup?.id != null ? String(r.adGroup.id) : null,
      metrics: mapMetrics(r.metrics),
    }));
}

// ---------------------------------------------------------------------------
// Draft engine surface: read / update / create
// ---------------------------------------------------------------------------

/**
 * Read a campaign's editable state in the shared snapshot shape (minor
 * units, shared status vocabulary). Used for drafting, drift checks, and
 * post-apply verification.
 */
export async function readGoogleCampaignState(
  auth: GoogleAdsAuth,
  campaignId: string,
): Promise<{
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}> {
  const rows = await gaqlSearch<RawCampaignRow>(
    auth,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.start_date, " +
      "campaign.end_date, campaign.campaign_budget, campaign_budget.amount_micros " +
      `FROM campaign WHERE campaign.id = ${Number(campaignId)}`,
  );
  const row = rows[0];
  if (!row?.campaign?.id) {
    throw new GoogleAdsApiError("Campaign not found in this Google Ads account.", 404);
  }
  const mapped = mapCampaignRow(row);
  return {
    name: mapped.name,
    status: mapped.status,
    dailyBudget: mapped.dailyBudget,
    lifetimeBudget: null,
    startTime: mapped.startTime,
    stopTime: mapped.stopTime,
  };
}

async function getCampaignBudgetResource(
  auth: GoogleAdsAuth,
  campaignId: string,
): Promise<string | null> {
  const rows = await gaqlSearch<RawCampaignRow>(
    auth,
    "SELECT campaign.id, campaign.campaign_budget FROM campaign " +
      `WHERE campaign.id = ${Number(campaignId)}`,
  );
  return rows[0]?.campaign?.campaignBudget ?? null;
}

export interface GoogleUpdateParams {
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  /** Minor units; converted to micros here. */
  dailyBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
}

/** Update a campaign (and its budget) in place. */
export async function updateGoogleCampaign(
  auth: GoogleAdsAuth,
  campaignId: string,
  params: GoogleUpdateParams,
): Promise<void> {
  const campaignFields: Record<string, unknown> = {};
  const mask: string[] = [];
  if (params.name != null) {
    campaignFields.name = params.name;
    mask.push("name");
  }
  if (params.status != null) {
    campaignFields.status = statusToGoogle(params.status);
    mask.push("status");
  }
  if (params.startTime != null) {
    campaignFields.startDate = toGoogleDate(params.startTime);
    mask.push("start_date");
  }
  if (params.stopTime != null) {
    campaignFields.endDate = toGoogleDate(params.stopTime);
    mask.push("end_date");
  }
  if (mask.length > 0) {
    await adsRequest(
      `customers/${encodeURIComponent(auth.customerId)}/campaigns:mutate`,
      auth,
      {
        method: "POST",
        body: {
          operations: [
            {
              updateMask: mask.join(","),
              update: {
                resourceName: `customers/${auth.customerId}/campaigns/${Number(campaignId)}`,
                ...campaignFields,
              },
            },
          ],
        },
      },
    );
  }
  if (params.dailyBudget != null) {
    const budgetResource = await getCampaignBudgetResource(auth, campaignId);
    if (!budgetResource) {
      throw new GoogleAdsApiError(
        "This campaign has no editable budget on Google Ads.",
        502,
      );
    }
    await adsRequest(
      `customers/${encodeURIComponent(auth.customerId)}/campaignBudgets:mutate`,
      auth,
      {
        method: "POST",
        body: {
          operations: [
            {
              updateMask: "amount_micros",
              update: {
                resourceName: budgetResource,
                amountMicros: String(minorToMicros(params.dailyBudget)),
              },
            },
          ],
        },
      },
    );
  }
}

export interface GoogleCreateCampaignParams {
  name: string;
  /** Advertising channel type, e.g. SEARCH or DISPLAY. */
  objective: string;
  status: "ACTIVE" | "PAUSED";
  /** Minor units. */
  dailyBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
}

const GOOGLE_CHANNEL_TYPES = new Set([
  "SEARCH",
  "DISPLAY",
  "SHOPPING",
  "VIDEO",
  "PERFORMANCE_MAX",
  "DEMAND_GEN",
]);

/** Create a campaign (budget first, then the campaign); returns its id. */
export async function createGoogleCampaign(
  auth: GoogleAdsAuth,
  params: GoogleCreateCampaignParams,
): Promise<string> {
  if (params.dailyBudget == null || params.dailyBudget <= 0) {
    throw new GoogleAdsApiError(
      "A daily budget is required to create a Google Ads campaign.",
      400,
    );
  }
  const channelType = GOOGLE_CHANNEL_TYPES.has(params.objective)
    ? params.objective
    : "SEARCH";

  const budgetRes = await adsRequest<{ results?: { resourceName?: string }[] }>(
    `customers/${encodeURIComponent(auth.customerId)}/campaignBudgets:mutate`,
    auth,
    {
      method: "POST",
      body: {
        operations: [
          {
            create: {
              name: `${params.name} budget ${Date.now()}`,
              amountMicros: String(minorToMicros(params.dailyBudget)),
              deliveryMethod: "STANDARD",
              explicitlyShared: false,
            },
          },
        ],
      },
    },
  );
  const budgetResource = budgetRes.results?.[0]?.resourceName;
  if (!budgetResource) {
    throw new GoogleAdsApiError("Google did not return a budget resource.", 502);
  }

  const campaign: Record<string, unknown> = {
    name: params.name,
    advertisingChannelType: channelType,
    status: statusToGoogle(params.status),
    campaignBudget: budgetResource,
    manualCpc: {},
  };
  if (params.startTime) campaign.startDate = toGoogleDate(params.startTime);
  if (params.stopTime) campaign.endDate = toGoogleDate(params.stopTime);

  const res = await adsRequest<{ results?: { resourceName?: string }[] }>(
    `customers/${encodeURIComponent(auth.customerId)}/campaigns:mutate`,
    auth,
    { method: "POST", body: { operations: [{ create: campaign }] } },
  );
  const resource = res.results?.[0]?.resourceName;
  const id = resource?.split("/").pop();
  if (!id) throw new GoogleAdsApiError("Google did not return a campaign id.", 502);
  return id;
}
