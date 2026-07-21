import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  db,
  adAccountConnectionsTable,
  adChangeRequestsTable,
  adsChangeLogsTable,
  tenantsTable,
  connectedAccountsTable,
  type AdAccountConnection,
  type AdChangeRequest,
  type AdsChangeLog,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  CreateAdDraftBody,
  SelectMetaAdAccountBody,
  SelectLinkedinAdAccountBody,
  SelectGoogleAdAccountBody,
  AdminUpdateAdsSettingsBody,
  UpdateAdsBudgetCapsBody,
} from "@workspace/api-zod";
import { requireWorkspaceAdmin } from "../middlewares/requireWorkspaceAdmin";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";
import { encryptJson, decryptJson } from "../lib/secretCrypto";
import {
  signOAuthState,
  verifySignedOAuthState,
  randomNonce,
} from "../lib/oauthState";
import { platformFetch } from "../lib/platformFetch";
import {
  getMetaAppCredentials,
  isMetaAppConfigured,
  GRAPH_BASE,
  GRAPH_VERSION,
  type FacebookCredentials,
} from "../lib/metaApi";
import {
  MetaAdsApiError,
  listAdAccounts,
  readAdAccount,
  listCampaigns,
  getCampaign,
  listAdSets,
  listAds,
  getInsightsByLevel,
  readObjectState,
  ADS_DATE_PRESETS,
  EMPTY_INSIGHTS,
  adsGraphBase,
  type AdsDatePreset,
  type MetaAdsCredentials,
} from "../lib/metaAdsApi";
import {
  LinkedinAdsApiError,
  listLinkedinAdAccounts,
  readLinkedinAdAccount,
  listLinkedinCampaignGroups,
  listLinkedinCampaigns,
  getLinkedinCampaign,
  getLinkedinAnalytics,
  listLinkedinCreatives,
  readLinkedinPostPreview,
  type LinkedinPostPreview,
  searchLinkedinGeoLocations,
  searchLinkedinTargetingEntities,
  resolveLinkedinTargetingEntityNames,
  LINKEDIN_TARGETING_FACETS,
  LINKEDIN_TARGETING_FACET_KEYS,
  type LinkedinTargetingFacetKey,
  type LinkedinAdsCredentials,
} from "../lib/linkedinAdsApi";
import {
  getLinkedinAppCredentials,
  isLinkedinAppConfigured,
  LINKEDIN_AUTH_BASE,
  linkedinTokenUrl,
} from "../lib/linkedinApp";
import { maybeRefreshLinkedinAdsToken } from "../lib/linkedinAdsRefresh";
import {
  GoogleAdsApiError,
  isGoogleAdsConfigured,
  getGoogleAdsAppCredentials,
  buildGoogleAdsAuthUrl,
  exchangeGoogleAdsCode,
  getGoogleAdsAuth,
  listCustomerChoices,
  readCustomer,
  normalizeCustomerId,
  listGoogleCampaigns,
  getGoogleCampaign,
  listGoogleAdGroups,
  listGoogleAds,
  type GoogleAdsCredentials,
} from "../lib/googleAdsApi";
import {
  TiktokAdsApiError,
  TIKTOK_AUTH_PORTAL,
  getTiktokAppCredentials,
  isTiktokAppConfigured,
  exchangeAuthCode as exchangeTiktokAuthCode,
  listAdvertisers as listTiktokAdvertisers,
  readAdvertiser as readTiktokAdvertiser,
  listCampaigns as listTiktokCampaigns,
  getCampaign as getTiktokCampaign,
  listAdGroups as listTiktokAdGroups,
  listAdsForCampaign as listTiktokAds,
  getImageInfos as getTiktokImageInfos,
  getInsightsByLevel as getTiktokInsightsByLevel,
  toTiktokTime,
  TIKTOK_MIN_CAMPAIGN_BUDGET_MINOR,
  TIKTOK_MIN_ADGROUP_BUDGET_MINOR,
  EMPTY_TIKTOK_INSIGHTS,
  type TiktokAdsCredentials,
} from "../lib/tiktokAdsApi";
import {
  getAdsModuleEnabled,
  setAdsModuleEnabled,
  getAdsPlatformAvailability,
  getAdConnection,
  getConnectionToken,
  markAdConnectionFailed,
  markAdConnectionAuthFailed,
  buildUpdateDiff,
  buildCreateDiff,
  buildCreativeCreateDiff,
  snapshotForCompare,
  approveAndApplyDraft,
  readAdTargetState,
  defaultAdsObjective,
  isAdsAuthError,
  adsApiErrorStatus,
  asDraftTargetType,
  ADS_APPLY_IN_PROGRESS_MESSAGE,
  sortedUrns,
  type TargetingLocation,
  type ProposedTargetingFacets,
} from "../lib/adsEngine";
import {
  notifyAdsDraftPending,
  resolveAdsConnectionNotifications,
} from "../lib/notifications";
import { AD_SWEEP_PLATFORMS, reverifyAdConnection } from "../lib/adsReverify";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function serializeConnection(c: AdAccountConnection) {
  return {
    id: c.id,
    platform: c.platform,
    adAccountId: c.adAccountId,
    adAccountName: c.adAccountName,
    currency: c.currency ?? null,
    status: c.status,
    verifyStatus: c.verifyStatus ?? null,
    verifyError: c.verifyError ?? null,
    verifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

function serializeDraft(d: AdChangeRequest) {
  return {
    id: d.id,
    connectionId: d.connectionId,
    platform: d.platform,
    targetType: d.targetType,
    targetId: d.targetId ?? null,
    targetName: d.targetName,
    action: d.action,
    changes: d.changes,
    status: d.status,
    idempotencyKey: d.idempotencyKey,
    createdByEmail: d.createdByEmail ?? null,
    approvedByEmail: d.approvedByEmail ?? null,
    appliedAt: d.appliedAt ? d.appliedAt.toISOString() : null,
    resultTargetId: d.resultTargetId ?? null,
    verifyStatus: d.verifyStatus ?? null,
    failureReason: d.failureReason ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

function serializeLogEntry(l: AdsChangeLog) {
  return {
    id: l.id,
    platform: l.platform,
    targetType: l.targetType,
    targetId: l.targetId ?? null,
    targetName: l.targetName,
    action: l.action,
    changes: l.changes,
    outcome: l.outcome,
    verifyStatus: l.verifyStatus ?? null,
    failureReason: l.failureReason ?? null,
    approvedByEmail: l.approvedByEmail ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Module gate
// ---------------------------------------------------------------------------

const ADS_DISABLED_MESSAGE =
  "Paid media features are currently turned off by the platform administrator.";

async function adsEnabledOr503(res: Response): Promise<boolean> {
  if (await getAdsModuleEnabled()) return true;
  res.status(503).json({ error: ADS_DISABLED_MESSAGE });
  return false;
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Status + connections
// ---------------------------------------------------------------------------

router.get("/ads/status", async (_req: Request, res: Response) => {
  const [enabled, platforms] = await Promise.all([
    getAdsModuleEnabled(),
    getAdsPlatformAvailability(),
  ]);
  res.json({ enabled, platforms });
});

router.get("/ads/connections", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  // Proactively re-check the stored ads grants (staleness-gated) so an
  // expired/revoked one flips to "failed" the moment the page loads, mirroring
  // the Accounts page behavior. Transient errors are logged, never surfaced.
  for (const platform of AD_SWEEP_PLATFORMS) {
    try {
      await reverifyAdConnection(req.tenantId, platform);
    } catch (err) {
      req.log.error({ err, platform }, "Ads auto re-verify failed");
    }
  }
  const rows = await db
    .select()
    .from(adAccountConnectionsTable)
    .where(eq(adAccountConnectionsTable.tenantId, req.tenantId))
    .orderBy(adAccountConnectionsTable.platform);
  res.json(rows.map(serializeConnection));
});

router.delete(
  "/ads/connections/:id",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const id = Number(req.params.id);
    const deleted = await db
      .delete(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.id, id),
          eq(adAccountConnectionsTable.tenantId, req.tenantId),
        ),
      )
      .returning({ id: adAccountConnectionsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Meta connect: fresh OAuth grant with ads scopes
// ---------------------------------------------------------------------------

/**
 * Ads needs a USER access token carrying ads_management/ads_read — a
 * different grant than the Page token used for organic publishing, so the
 * connect flow runs its own OAuth dialog with ads scopes.
 */
const ADS_OAUTH_SCOPE = "ads_management,ads_read,business_management";

function adsRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/ads/meta/auth/callback`;
}

router.get(
  "/ads/meta/auth/url",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const creds = await getMetaAppCredentials();
    if (!creds || !process.env.SESSION_SECRET || !(await isMetaAppConfigured())) {
      res.status(503).json({
        error:
          "Meta Ads is not configured. Ask an administrator to save and verify the Meta app credentials on the Admin page.",
      });
      return;
    }
    const params = new URLSearchParams({
      client_id: creds.appId,
      redirect_uri: adsRedirectUri(req),
      scope: ADS_OAUTH_SCOPE,
      response_type: "code",
      state: signOAuthState(req.tenantId, randomNonce()),
    });
    res.json({
      url: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`,
    });
  },
);

/**
 * PUBLIC callback (mounted before the session gate): a top-level browser
 * redirect from facebook.com authenticated by the HMAC-signed `state`.
 */
export const adsCallbackRouter: IRouter = Router();

adsCallbackRouter.get(
  "/ads/meta/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/ads";
    const fail = (reason: string) =>
      res.redirect(`${webBase}?meta=error&reason=${encodeURIComponent(reason)}`);

    const creds = await getMetaAppCredentials();
    if (!creds || !process.env.SESSION_SECRET) {
      fail("not_configured");
      return;
    }
    const { code, state, error: oauthError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    if (oauthError) {
      fail(oauthError);
      return;
    }
    const verified = state ? verifySignedOAuthState(state) : null;
    if (!code || !verified) {
      fail("invalid_state");
      return;
    }
    const tenantId = verified.tenantId;

    try {
      // Exchange the code for a user token (secret in POST body, never URL).
      const tokenRes = await platformFetch(`${adsGraphBase()}/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.appId,
          client_secret: creds.appSecret,
          redirect_uri: adsRedirectUri(req),
          code,
        }).toString(),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: { message?: string };
      };
      if (!tokenRes.ok || !tokenJson.access_token) {
        req.log.error(
          { status: tokenRes.status, error: tokenJson.error?.message },
          "Meta ads token exchange failed",
        );
        fail("token_exchange");
        return;
      }

      // Exchange for a long-lived (~60 day) user token.
      let accessToken = tokenJson.access_token;
      try {
        const longRes = await platformFetch(`${adsGraphBase()}/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: creds.appId,
            client_secret: creds.appSecret,
            fb_exchange_token: accessToken,
          }).toString(),
        });
        const longJson = (await longRes.json()) as { access_token?: string };
        if (longRes.ok && longJson.access_token) accessToken = longJson.access_token;
      } catch {
        // Long-lived exchange is best-effort; the short token still works now.
      }

      await upsertPendingMetaConnection(tenantId, accessToken);
      res.redirect(`${webBase}?meta=connected`);
    } catch (err) {
      req.log.error({ err }, "Meta ads OAuth callback failed");
      fail("callback_error");
    }
  },
);

async function upsertPendingMetaConnection(
  tenantId: number,
  accessToken: string,
): Promise<AdAccountConnection> {
  return upsertPendingAdsConnection(tenantId, "meta", {
    accessToken,
  } satisfies MetaAdsCredentials);
}

async function upsertPendingAdsConnection(
  tenantId: number,
  platform: "meta" | "linkedin",
  credentials: MetaAdsCredentials | LinkedinAdsCredentials,
): Promise<AdAccountConnection> {
  const encrypted = encryptJson(credentials);
  const existing = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    const pending = (
      await db
        .update(adAccountConnectionsTable)
        .set({
          encryptedCredentials: encrypted,
          status: "pending_selection",
          adAccountId: "",
          adAccountName: "",
          currency: null,
          verifyStatus: null,
          verifyError: null,
          verifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(adAccountConnectionsTable.id, existing.id))
        .returning()
    )[0]!;
    // Reconnect fast path: if the fresh grant still includes the previously
    // selected ad account, auto-verify it so the tenant skips the re-pick
    // (mirrors the TikTok/Google reconnect pattern). Fails soft back to the
    // normal picker on any verification error.
    const previousId = existing.adAccountId;
    if (previousId) {
      try {
        const info =
          platform === "meta"
            ? await readAdAccount(credentials.accessToken, previousId)
            : await readLinkedinAdAccount(credentials.accessToken, previousId);
        const verified = (
          await db
            .update(adAccountConnectionsTable)
            .set({
              adAccountId: previousId,
              adAccountName: info.name,
              currency: info.currency,
              status: "connected",
              verifyStatus: "verified",
              verifyError: null,
              verifiedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(adAccountConnectionsTable.id, existing.id))
            .returning()
        )[0]!;
        await resolveAdsConnectionNotifications(tenantId, platform);
        return verified;
      } catch {
        // Verification failed — leave the connection pending selection.
      }
    }
    return pending;
  }
  return (
    await db
      .insert(adAccountConnectionsTable)
      .values({
        tenantId,
        platform,
        status: "pending_selection",
        encryptedCredentials: encrypted,
      })
      .returning()
  )[0]!;
}

// ---------------------------------------------------------------------------
// Meta connect: reuse the stored Facebook connection's token (best-effort)
// ---------------------------------------------------------------------------

router.post(
  "/ads/connections/meta/from-facebook",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const fbRow = (
      await db
        .select()
        .from(connectedAccountsTable)
        .where(
          and(
            eq(connectedAccountsTable.tenantId, req.tenantId),
            eq(connectedAccountsTable.platform, "facebook"),
          ),
        )
        .limit(1)
    )[0];
    if (!fbRow?.encryptedCredentials) {
      res.status(400).json({
        error:
          "No Facebook connection found. Connect your Facebook Page first, or use the direct Meta Ads sign-in.",
      });
      return;
    }
    let token: string | null = null;
    try {
      token = decryptJson<FacebookCredentials>(fbRow.encryptedCredentials)
        .pageAccessToken ?? null;
    } catch {
      token = null;
    }
    if (!token) {
      res.status(400).json({
        error:
          "The stored Facebook credentials could not be read. Use the direct Meta Ads sign-in instead.",
      });
      return;
    }
    try {
      const accounts = await listAdAccounts(token);
      if (accounts.length === 0) {
        res.status(400).json({
          error:
            "Your Facebook connection works, but its access does not include any ad accounts. Use the direct Meta Ads sign-in to grant ads access.",
        });
        return;
      }
      const conn = await upsertPendingMetaConnection(req.tenantId, token);
      res.json(serializeConnection(conn));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Meta rejected the token.";
      res.status(400).json({
        error: `The stored Facebook token cannot access ad accounts (${message}). Use the direct Meta Ads sign-in to grant ads access.`,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// TikTok connect: advertiser OAuth via the TikTok for Business portal
// ---------------------------------------------------------------------------

function tiktokAdsRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/ads/tiktok/auth/callback`;
}

router.get(
  "/ads/tiktok/auth/url",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const creds = await getTiktokAppCredentials();
    if (!creds || !process.env.SESSION_SECRET) {
      res.status(503).json({
        error:
          "TikTok Ads is not configured. Ask an administrator to save the TikTok for Business app credentials on the Admin page.",
      });
      return;
    }
    const params = new URLSearchParams({
      app_id: creds.appId,
      state: signOAuthState(req.tenantId, randomNonce()),
      redirect_uri: tiktokAdsRedirectUri(req),
    });
    res.json({ url: `${TIKTOK_AUTH_PORTAL}?${params.toString()}` });
  },
);

/**
 * PUBLIC callback (mounted before the session gate): a top-level browser
 * redirect from tiktok.com authenticated by the HMAC-signed `state`.
 */
adsCallbackRouter.get(
  "/ads/tiktok/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/ads";
    const fail = (reason: string) =>
      res.redirect(`${webBase}?tiktok=error&reason=${encodeURIComponent(reason)}`);

    const creds = await getTiktokAppCredentials();
    if (!creds || !process.env.SESSION_SECRET) {
      fail("not_configured");
      return;
    }
    const { auth_code: authCode, code, state } = req.query as {
      auth_code?: string;
      code?: string;
      state?: string;
    };
    const grantCode = authCode || code;
    const verified = state ? verifySignedOAuthState(state) : null;
    if (!grantCode || !verified) {
      fail("invalid_state");
      return;
    }

    try {
      const tiktokCreds = await exchangeTiktokAuthCode(creds, grantCode);
      await upsertPendingTiktokConnection(verified.tenantId, tiktokCreds);
      res.redirect(`${webBase}?tiktok=connected`);
    } catch (err) {
      req.log.error({ err }, "TikTok ads OAuth callback failed");
      fail("token_exchange");
    }
  },
);

async function upsertPendingTiktokConnection(
  tenantId: number,
  creds: TiktokAdsCredentials,
): Promise<AdAccountConnection> {
  const encrypted = encryptJson(creds);
  const existing = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, "tiktok"),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    const pending = (
      await db
        .update(adAccountConnectionsTable)
        .set({
          encryptedCredentials: encrypted,
          status: "pending_selection",
          adAccountId: "",
          adAccountName: "",
          currency: null,
          verifyStatus: null,
          verifyError: null,
          verifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(adAccountConnectionsTable.id, existing.id))
        .returning()
    )[0]!;
    // Reconnect fast path: if the fresh grant still includes the previously
    // selected advertiser, auto-verify it so the tenant skips the re-pick.
    // Fails soft back to the normal picker on any error.
    const previousId = existing.adAccountId;
    if (previousId && (creds.advertiserIds ?? []).includes(previousId)) {
      try {
        const info = await readTiktokAdvertiser(creds.accessToken, previousId);
        const verified = (
          await db
            .update(adAccountConnectionsTable)
            .set({
              adAccountId: previousId,
              adAccountName: info.name,
              currency: info.currency,
              status: "connected",
              verifyStatus: "verified",
              verifyError: null,
              verifiedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(adAccountConnectionsTable.id, existing.id))
            .returning()
        )[0]!;
        await resolveAdsConnectionNotifications(tenantId, "tiktok");
        return verified;
      } catch {
        // Verification failed — leave the connection pending selection.
      }
    }
    return pending;
  }
  return (
    await db
      .insert(adAccountConnectionsTable)
      .values({
        tenantId,
        platform: "tiktok",
        status: "pending_selection",
        encryptedCredentials: encrypted,
      })
      .returning()
  )[0]!;
}

async function getTiktokConnection(
  tenantId: number,
): Promise<AdAccountConnection | null> {
  const row = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, "tiktok"),
        ),
      )
      .limit(1)
  )[0];
  return row ?? null;
}

function getTiktokAdvertiserIds(conn: AdAccountConnection): string[] {
  try {
    return (
      decryptJson<TiktokAdsCredentials>(conn.encryptedCredentials ?? "")
        .advertiserIds ?? []
    );
  } catch {
    return [];
  }
}

router.get(
  "/ads/connections/tiktok/accounts",
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const conn = await getTiktokConnection(req.tenantId);
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token) {
      res.status(400).json({
        error: "Connect TikTok Ads first, then pick an advertiser account.",
      });
      return;
    }
    try {
      const advertisers = await listTiktokAdvertisers(
        token,
        getTiktokAdvertiserIds(conn),
      );
      res.json(
        advertisers.map((a) => ({
          adAccountId: a.advertiserId,
          name: a.name,
          currency: a.currency,
          accountStatus: a.status,
        })),
      );
    } catch (err) {
      if (err instanceof TiktokAdsApiError && err.authFailed) {
        await markAdConnectionFailed(conn.id, err.message);
      }
      res.status(502).json({
        error:
          err instanceof Error ? err.message : "Could not list advertiser accounts.",
      });
    }
  },
);

router.post(
  "/ads/connections/tiktok/select",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const parsed = SelectMetaAdAccountBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "adAccountId is required" });
      return;
    }
    const conn = await getTiktokConnection(req.tenantId);
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token) {
      res.status(400).json({ error: "Connect TikTok Ads first." });
      return;
    }
    if (!getTiktokAdvertiserIds(conn).includes(parsed.data.adAccountId)) {
      res.status(400).json({
        error: "That advertiser account is not part of this TikTok grant.",
      });
      return;
    }
    try {
      const info = await readTiktokAdvertiser(token, parsed.data.adAccountId);
      const updated = (
        await db
          .update(adAccountConnectionsTable)
          .set({
            adAccountId: parsed.data.adAccountId,
            adAccountName: info.name,
            currency: info.currency,
            status: "connected",
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(adAccountConnectionsTable.id, conn.id))
          .returning()
      )[0]!;
      // The grant just verified again — auto-dismiss any lingering
      // "ad account disconnected" notification for this platform.
      await resolveAdsConnectionNotifications(req.tenantId, "tiktok");
      res.json(serializeConnection(updated));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? `That advertiser account could not be verified: ${err.message}`
            : "That advertiser account could not be verified.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Ad account selection
// ---------------------------------------------------------------------------

async function getPlatformConnection(
  tenantId: number,
  platform: "meta" | "google" | "linkedin" | "tiktok",
): Promise<AdAccountConnection | null> {
  const row = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  // Silent on-demand token refresh for LinkedIn (no-op for other platforms).
  return await maybeRefreshLinkedinAdsToken(row);
}

function getMetaConnection(tenantId: number): Promise<AdAccountConnection | null> {
  return getPlatformConnection(tenantId, "meta");
}

router.get(
  "/ads/connections/meta/accounts",
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const conn = await getMetaConnection(req.tenantId);
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token) {
      res.status(400).json({
        error: "Connect Meta Ads first, then pick an ad account.",
      });
      return;
    }
    try {
      const accounts = await listAdAccounts(token);
      res.json(
        accounts.map((a) => ({
          adAccountId: a.adAccountId,
          name: a.name,
          currency: a.currency,
          accountStatus: a.accountStatus,
        })),
      );
    } catch (err) {
      if (err instanceof MetaAdsApiError && err.authFailed) {
        await markAdConnectionFailed(conn.id, err.message);
      }
      res.status(502).json({
        error: err instanceof Error ? err.message : "Could not list ad accounts.",
      });
    }
  },
);

router.post(
  "/ads/connections/meta/select",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const parsed = SelectMetaAdAccountBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "adAccountId is required" });
      return;
    }
    const conn = await getMetaConnection(req.tenantId);
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token) {
      res.status(400).json({ error: "Connect Meta Ads first." });
      return;
    }
    try {
      const info = await readAdAccount(token, parsed.data.adAccountId);
      const updated = (
        await db
          .update(adAccountConnectionsTable)
          .set({
            adAccountId: parsed.data.adAccountId,
            adAccountName: info.name,
            currency: info.currency,
            status: "connected",
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(adAccountConnectionsTable.id, conn.id))
          .returning()
      )[0]!;
      // The grant just verified again — auto-dismiss any lingering
      // "ad account disconnected" notification for this platform.
      await resolveAdsConnectionNotifications(req.tenantId, "meta");
      res.json(serializeConnection(updated));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? `That ad account could not be verified: ${err.message}`
            : "That ad account could not be verified.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// LinkedIn connect: fresh OAuth grant with ads scopes
// ---------------------------------------------------------------------------

/**
 * LinkedIn ads needs a member token carrying the Advertising API scopes — a
 * different grant than the w_member_social token used for organic publishing,
 * so the connect flow runs its own OAuth dialog with ads scopes.
 */
const LINKEDIN_ADS_OAUTH_SCOPE = "r_ads rw_ads r_ads_reporting";

function linkedinAdsRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/ads/linkedin/auth/callback`;
}

router.get(
  "/ads/linkedin/auth/url",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const creds = await getLinkedinAppCredentials();
    if (!creds || !(await isLinkedinAppConfigured())) {
      res.status(503).json({
        error:
          "LinkedIn Ads is not configured. Ask an administrator to save the LinkedIn app credentials on the Admin page.",
      });
      return;
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: creds.clientId,
      redirect_uri: linkedinAdsRedirectUri(req),
      scope: LINKEDIN_ADS_OAUTH_SCOPE,
      state: signOAuthState(req.tenantId, randomNonce()),
    });
    res.json({ url: `${LINKEDIN_AUTH_BASE}?${params.toString()}` });
  },
);

// ---------------------------------------------------------------------------
// Google Ads connect: OAuth grant with the AdWords scope
// ---------------------------------------------------------------------------

function googleAdsRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/ads/google/auth/callback`;
}

router.get(
  "/ads/google/auth/url",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const creds = await getGoogleAdsAppCredentials();
    if (!creds || !process.env.SESSION_SECRET) {
      res.status(503).json({
        error:
          "Google Ads is not configured. Ask an administrator to save the Google Ads credentials on the Admin page.",
      });
      return;
    }
    res.json({
      url: buildGoogleAdsAuthUrl(
        creds.clientId,
        googleAdsRedirectUri(req),
        signOAuthState(req.tenantId, randomNonce()),
      ),
    });
  },
);

/**
 * PUBLIC callback (mounted before the session gate): a top-level browser
 * redirect from linkedin.com authenticated by the HMAC-signed `state`.
 */
adsCallbackRouter.get(
  "/ads/linkedin/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/ads";
    const fail = (reason: string) =>
      res.redirect(
        `${webBase}?linkedin=error&reason=${encodeURIComponent(reason)}`,
      );

    const creds = await getLinkedinAppCredentials();
    if (!creds || !process.env.SESSION_SECRET) {
      fail("not_configured");
      return;
    }
    const { code, state, error: oauthError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    if (oauthError) {
      fail(oauthError);
      return;
    }
    const verified = state ? verifySignedOAuthState(state) : null;
    if (!code || !verified) {
      fail("invalid_state");
      return;
    }
    const tenantId = verified.tenantId;

    try {
      // linkedinTokenUrl() honors the dev-only LINKEDIN_TOKEN_URL_OVERRIDE so
      // browser e2e runs can complete the reconnect flow against a local mock.
      const tokenRes = await platformFetch(linkedinTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: linkedinAdsRedirectUri(req),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }).toString(),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenJson.access_token) {
        req.log.error(
          { status: tokenRes.status, error: tokenJson.error_description },
          "LinkedIn ads token exchange failed",
        );
        fail("token_exchange");
        return;
      }
      const now = Date.now();
      await upsertPendingAdsConnection(tenantId, "linkedin", {
        accessToken: tokenJson.access_token,
        expiresAt:
          tokenJson.expires_in != null
            ? now + tokenJson.expires_in * 1000
            : undefined,
        // Store the programmatic refresh token (when LinkedIn issues one) so
        // the background refresher can renew the access token silently
        // instead of forcing the tenant to reconnect every ~60 days.
        refreshToken: tokenJson.refresh_token,
        refreshTokenExpiresAt:
          tokenJson.refresh_token != null &&
          tokenJson.refresh_token_expires_in != null
            ? now + tokenJson.refresh_token_expires_in * 1000
            : undefined,
      } satisfies LinkedinAdsCredentials);
      res.redirect(`${webBase}?linkedin=connected`);
    } catch (err) {
      req.log.error({ err }, "LinkedIn ads OAuth callback failed");
      fail("callback_error");
    }
  },
);

/**
 * PUBLIC callback (mounted before the session gate): a top-level browser
 * redirect from accounts.google.com authenticated by the HMAC-signed `state`.
 */
adsCallbackRouter.get(
  "/ads/google/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/ads";
    const fail = (reason: string) =>
      res.redirect(`${webBase}?google=error&reason=${encodeURIComponent(reason)}`);

    if (!(await isGoogleAdsConfigured()) || !process.env.SESSION_SECRET) {
      fail("not_configured");
      return;
    }
    const { code, state, error: oauthError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    if (oauthError) {
      fail(oauthError);
      return;
    }
    const verified = state ? verifySignedOAuthState(state) : null;
    if (!code || !verified) {
      fail("invalid_state");
      return;
    }
    const tenantId = verified.tenantId;

    try {
      const tokens = await exchangeGoogleAdsCode(code, googleAdsRedirectUri(req));
      if (!tokens.refreshToken) {
        fail("no_refresh_token");
        return;
      }
      await upsertPendingGoogleConnection(tenantId, {
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: new Date(
          Date.now() + tokens.expiresIn * 1000,
        ).toISOString(),
      });
      res.redirect(`${webBase}?google=connected`);
    } catch (err) {
      req.log.error({ err }, "Google Ads OAuth callback failed");
      fail("callback_error");
    }
  },
);

async function upsertPendingGoogleConnection(
  tenantId: number,
  creds: GoogleAdsCredentials,
): Promise<AdAccountConnection> {
  const encrypted = encryptJson(creds);
  const existing = await getPlatformConnection(tenantId, "google");
  if (existing) {
    // Carry the previously selected account + MCC login id so we can try the
    // reconnect fast path below.
    const previousId = existing.adAccountId;
    let previousLoginCustomerId: string | null = null;
    if (previousId && existing.encryptedCredentials) {
      try {
        previousLoginCustomerId =
          decryptJson<GoogleAdsCredentials>(existing.encryptedCredentials)
            .loginCustomerId ?? null;
      } catch {
        previousLoginCustomerId = null;
      }
    }
    const pending = (
      await db
        .update(adAccountConnectionsTable)
        .set({
          encryptedCredentials: encrypted,
          status: "pending_selection",
          adAccountId: "",
          adAccountName: "",
          currency: null,
          verifyStatus: null,
          verifyError: null,
          verifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(adAccountConnectionsTable.id, existing.id))
        .returning()
    )[0]!;
    // Reconnect fast path: if the fresh grant can still read the previously
    // selected customer (with the same MCC login id, if any), auto-verify it
    // so the tenant skips the re-pick. Fails soft back to the picker.
    if (previousId) {
      try {
        const next: GoogleAdsCredentials = {
          ...creds,
          loginCustomerId: previousLoginCustomerId,
        };
        await db
          .update(adAccountConnectionsTable)
          .set({
            encryptedCredentials: encryptJson(next),
            adAccountId: previousId,
            updatedAt: new Date(),
          })
          .where(eq(adAccountConnectionsTable.id, existing.id));
        const fresh = (
          await db
            .select()
            .from(adAccountConnectionsTable)
            .where(eq(adAccountConnectionsTable.id, existing.id))
            .limit(1)
        )[0]!;
        const auth = await getGoogleAdsAuth(fresh);
        const info = await readCustomer(auth);
        const verified = (
          await db
            .update(adAccountConnectionsTable)
            .set({
              adAccountName: info.name,
              currency: info.currency,
              status: "connected",
              verifyStatus: "verified",
              verifyError: null,
              verifiedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(adAccountConnectionsTable.id, existing.id))
            .returning()
        )[0]!;
        await resolveAdsConnectionNotifications(tenantId, "google");
        return verified;
      } catch {
        // Verification failed — revert to the normal picker flow.
        return (
          await db
            .update(adAccountConnectionsTable)
            .set({
              encryptedCredentials: encrypted,
              adAccountId: "",
              updatedAt: new Date(),
            })
            .where(eq(adAccountConnectionsTable.id, existing.id))
            .returning()
        )[0]!;
      }
    }
    return pending;
  }
  return (
    await db
      .insert(adAccountConnectionsTable)
      .values({
        tenantId,
        platform: "google",
        status: "pending_selection",
        encryptedCredentials: encrypted,
      })
      .returning()
  )[0]!;
}

router.get(
  "/ads/connections/linkedin/accounts",
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const conn = await getPlatformConnection(req.tenantId, "linkedin");
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token) {
      res.status(400).json({
        error: "Connect LinkedIn Ads first, then pick an ad account.",
      });
      return;
    }
    try {
      const accounts = await listLinkedinAdAccounts(token);
      res.json(
        accounts.map((a) => ({
          adAccountId: a.adAccountId,
          name: a.name,
          currency: a.currency,
          accountStatus: a.accountStatus,
        })),
      );
    } catch (err) {
      if (err instanceof LinkedinAdsApiError && err.authFailed) {
        await markAdConnectionAuthFailed(conn, err.message);
      }
      res.status(502).json({
        error: err instanceof Error ? err.message : "Could not list ad accounts.",
      });
    }
  },
);

router.get(
  "/ads/connections/google/accounts",
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const conn = await getPlatformConnection(req.tenantId, "google");
    if (!conn?.encryptedCredentials) {
      res.status(400).json({
        error: "Connect Google Ads first, then pick an ad account.",
      });
      return;
    }
    try {
      const auth = await getGoogleAdsAuth(conn);
      const choices = await listCustomerChoices(auth);
      res.json(choices);
    } catch (err) {
      if (isAdsAuthError(err)) {
        await markAdConnectionFailed(conn.id, (err as Error).message);
      }
      res.status(502).json({
        error: err instanceof Error ? err.message : "Could not list Google Ads accounts.",
      });
    }
  },
);

router.post(
  "/ads/connections/linkedin/select",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const parsed = SelectLinkedinAdAccountBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "adAccountId is required" });
      return;
    }
    const conn = await getPlatformConnection(req.tenantId, "linkedin");
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token) {
      res.status(400).json({ error: "Connect LinkedIn Ads first." });
      return;
    }
    try {
      const info = await readLinkedinAdAccount(token, parsed.data.adAccountId);
      const updated = (
        await db
          .update(adAccountConnectionsTable)
          .set({
            adAccountId: parsed.data.adAccountId,
            adAccountName: info.name,
            currency: info.currency,
            status: "connected",
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(adAccountConnectionsTable.id, conn.id))
          .returning()
      )[0]!;
      // The grant just verified again — auto-dismiss any lingering
      // "ad account disconnected" notification for this platform.
      await resolveAdsConnectionNotifications(req.tenantId, "linkedin");
      res.json(serializeConnection(updated));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? `That ad account could not be verified: ${err.message}`
            : "That ad account could not be verified.",
      });
    }
  },
);

router.post(
  "/ads/connections/google/select",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const parsed = SelectGoogleAdAccountBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "customerId is required" });
      return;
    }
    const conn = await getPlatformConnection(req.tenantId, "google");
    if (!conn?.encryptedCredentials) {
      res.status(400).json({ error: "Connect Google Ads first." });
      return;
    }
    const customerId = normalizeCustomerId(parsed.data.customerId);
    if (!customerId) {
      res.status(400).json({ error: "customerId is required" });
      return;
    }
    const loginCustomerId = parsed.data.loginCustomerId
      ? normalizeCustomerId(parsed.data.loginCustomerId)
      : null;
    try {
      const stored = decryptJson<GoogleAdsCredentials>(conn.encryptedCredentials);
      const next: GoogleAdsCredentials = { ...stored, loginCustomerId };
      await db
        .update(adAccountConnectionsTable)
        .set({
          encryptedCredentials: encryptJson(next),
          adAccountId: customerId,
          updatedAt: new Date(),
        })
        .where(eq(adAccountConnectionsTable.id, conn.id));
      const fresh = await getAdConnection(req.tenantId, conn.id);
      const auth = await getGoogleAdsAuth(fresh!);
      const info = await readCustomer(auth);
      const updated = (
        await db
          .update(adAccountConnectionsTable)
          .set({
            adAccountName: info.name,
            currency: info.currency,
            status: "connected",
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(adAccountConnectionsTable.id, conn.id))
          .returning()
      )[0]!;
      // The grant just verified again — auto-dismiss any lingering
      // "ad account disconnected" notification for this platform.
      await resolveAdsConnectionNotifications(req.tenantId, "google");
      res.json(serializeConnection(updated));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? `That Google Ads account could not be verified: ${err.message}`
            : "That Google Ads account could not be verified.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Campaign reads + insights
// ---------------------------------------------------------------------------

function parseDatePreset(value: unknown): AdsDatePreset {
  return ADS_DATE_PRESETS.includes(value as AdsDatePreset)
    ? (value as AdsDatePreset)
    : "last_30d";
}

async function requireConnectedConnection(
  req: Request,
  res: Response,
): Promise<{ conn: AdAccountConnection; token: string } | null> {
  const connectionId = Number(req.query.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    res.status(400).json({ error: "connectionId is required" });
    return null;
  }
  const conn = await getAdConnection(req.tenantId, connectionId);
  if (!conn || conn.status !== "connected" || !conn.encryptedCredentials) {
    res.status(400).json({
      error: "This ad account connection is missing or needs reconnecting.",
    });
    return null;
  }
  // LinkedIn reads need the raw member token here; Meta/TikTok branches fetch
  // their token via requireMetaToken and Google reads its own credentials.
  const token = conn.platform === "linkedin" ? getConnectionToken(conn) : null;
  if (conn.platform === "linkedin" && !token) {
    res.status(400).json({
      error: "This ad account connection is missing or needs reconnecting.",
    });
    return null;
  }
  return { conn, token: token ?? "" };
}

/** Meta reads still need the raw user token. */
function requireMetaToken(conn: AdAccountConnection, res: Response): string | null {
  const token = getConnectionToken(conn);
  if (!token) {
    res.status(400).json({
      error: "This ad account connection is missing or needs reconnecting.",
    });
    return null;
  }
  return token;
}

router.get("/ads/linkedin/campaign-groups", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const ct = await requireConnectedConnection(req, res);
  if (!ct) return;
  if (ct.conn.platform !== "linkedin") {
    res.status(400).json({ error: "This connection is not a LinkedIn ad account." });
    return;
  }
  const datePreset = parseDatePreset(req.query.datePreset);
  try {
    const [groups, metrics] = await Promise.all([
      listLinkedinCampaignGroups(ct.token, ct.conn.adAccountId),
      getLinkedinAnalytics(ct.token, ct.conn.adAccountId, "CAMPAIGN_GROUP", datePreset),
    ]);
    res.json({
      currency: ct.conn.currency ?? null,
      groups: groups.map((g) => ({
        ...g,
        metrics: metrics.get(g.id) ?? EMPTY_INSIGHTS,
      })),
    });
  } catch (err) {
    const authLost = isAdsAuthError(err);
    if (authLost) {
      await markAdConnectionAuthFailed(ct.conn, (err as Error).message);
    }
    res.status(502).json({
      error: err instanceof Error ? err.message : "Could not load campaign groups.",
      ...(authLost ? { authLost: true } : {}),
    });
  }
});

router.get("/ads/linkedin/geo-search", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const ct = await requireConnectedConnection(req, res);
  if (!ct) return;
  if (ct.conn.platform !== "linkedin") {
    res.status(400).json({ error: "This connection is not a LinkedIn ad account." });
    return;
  }
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2 || q.length > 100) {
    res.status(400).json({ error: "q must be between 2 and 100 characters." });
    return;
  }
  try {
    const results = await searchLinkedinGeoLocations(ct.token, q);
    res.json({ results });
  } catch (err) {
    const authLost = isAdsAuthError(err);
    if (authLost) {
      await markAdConnectionAuthFailed(ct.conn, (err as Error).message);
    }
    res.status(502).json({
      error: err instanceof Error ? err.message : "Could not search locations.",
      ...(authLost ? { authLost: true } : {}),
    });
  }
});

router.get("/ads/linkedin/targeting-search", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const ct = await requireConnectedConnection(req, res);
  if (!ct) return;
  if (ct.conn.platform !== "linkedin") {
    res.status(400).json({ error: "This connection is not a LinkedIn ad account." });
    return;
  }
  const facet = String(req.query.facet ?? "");
  if (!LINKEDIN_TARGETING_FACET_KEYS.includes(facet as LinkedinTargetingFacetKey)) {
    res.status(400).json({
      error: `facet must be one of: ${LINKEDIN_TARGETING_FACET_KEYS.join(", ")}.`,
    });
    return;
  }
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2 || q.length > 100) {
    res.status(400).json({ error: "q must be between 2 and 100 characters." });
    return;
  }
  try {
    const results = await searchLinkedinTargetingEntities(
      ct.token,
      facet as LinkedinTargetingFacetKey,
      q,
    );
    res.json({ results });
  } catch (err) {
    const authLost = isAdsAuthError(err);
    if (authLost) {
      await markAdConnectionAuthFailed(ct.conn, (err as Error).message);
    }
    res.status(502).json({
      error: err instanceof Error ? err.message : "Could not search targeting entities.",
      ...(authLost ? { authLost: true } : {}),
    });
  }
});

router.get("/ads/linkedin/campaign-targeting", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const ct = await requireConnectedConnection(req, res);
  if (!ct) return;
  if (ct.conn.platform !== "linkedin") {
    res.status(400).json({ error: "This connection is not a LinkedIn ad account." });
    return;
  }
  const campaignId = String(req.query.campaignId ?? "").trim();
  if (!campaignId) {
    res.status(400).json({ error: "campaignId is required." });
    return;
  }
  try {
    const campaign = await getLinkedinCampaign(ct.token, ct.conn.adAccountId, campaignId);
    const facetUrns: Record<LinkedinTargetingFacetKey, string[]> = {
      locations: campaign.targetingLocations,
      industries: campaign.targetingIndustries,
      jobFunctions: campaign.targetingJobFunctions,
      titles: campaign.targetingTitles,
    };
    const allUrns = LINKEDIN_TARGETING_FACET_KEYS.flatMap((k) => facetUrns[k]);
    const names =
      allUrns.length > 0
        ? await resolveLinkedinTargetingEntityNames(ct.token, allUrns)
        : new Map<string, string>();
    const toEntities = (urns: string[]) =>
      urns.map((urn) => ({ urn, name: names.get(urn) ?? urn }));
    res.json({
      locations: toEntities(facetUrns.locations),
      industries: toEntities(facetUrns.industries),
      jobFunctions: toEntities(facetUrns.jobFunctions),
      titles: toEntities(facetUrns.titles),
    });
  } catch (err) {
    const authLost = isAdsAuthError(err);
    if (authLost) {
      await markAdConnectionAuthFailed(ct.conn, (err as Error).message);
    }
    res.status(502).json({
      error:
        err instanceof Error ? err.message : "Could not load the campaign's targeting.",
      ...(authLost ? { authLost: true } : {}),
    });
  }
});

router.get("/ads/campaigns", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const ct = await requireConnectedConnection(req, res);
  if (!ct) return;
  const { conn } = ct;
  const datePreset = parseDatePreset(req.query.datePreset);
  try {
    if (ct.conn.platform === "linkedin") {
      const [campaigns, groups, metrics] = await Promise.all([
        listLinkedinCampaigns(ct.token, ct.conn.adAccountId),
        listLinkedinCampaignGroups(ct.token, ct.conn.adAccountId),
        getLinkedinAnalytics(ct.token, ct.conn.adAccountId, "CAMPAIGN", datePreset),
      ]);
      const groupNames = new Map(groups.map((g) => [g.id, g.name]));
      res.json({
        currency: ct.conn.currency ?? null,
        campaigns: campaigns.map((c) => ({
          ...c,
          campaignGroupName: c.campaignGroupId
            ? groupNames.get(c.campaignGroupId) ?? null
            : null,
          metrics: metrics.get(c.id) ?? EMPTY_INSIGHTS,
        })),
      });
      return;
    }

    if (conn.platform === "google") {
      const auth = await getGoogleAdsAuth(conn);
      const campaigns = await listGoogleCampaigns(auth, datePreset);
      res.json({ currency: conn.currency ?? null, campaigns });
      return;
    }

    const token = requireMetaToken(conn, res);
    if (!token) return;

    const [campaigns, insights] =
      ct.conn.platform === "tiktok"
        ? await Promise.all([
            listTiktokCampaigns(token, ct.conn.adAccountId),
            getTiktokInsightsByLevel(
              token,
              ct.conn.adAccountId,
              "campaign",
              datePreset,
            ),
          ])
        : await Promise.all([
            listCampaigns(token, ct.conn.adAccountId),
            getInsightsByLevel(token, ct.conn.adAccountId, "campaign", datePreset),
          ]);
    const empty =
      ct.conn.platform === "tiktok" ? EMPTY_TIKTOK_INSIGHTS : EMPTY_INSIGHTS;
    res.json({
      currency: conn.currency ?? null,
      campaigns: campaigns.map((c) => ({
        ...c,
        metrics: insights.get(c.id) ?? empty,
      })),
    });
  } catch (err) {
    const authLost = isAdsAuthError(err);
    if (authLost) {
      await markAdConnectionAuthFailed(ct.conn, (err as Error).message);
    }
    res.status(502).json({
      error: err instanceof Error ? err.message : "Could not load campaigns.",
      ...(authLost ? { authLost: true } : {}),
    });
  }
});

// Short-lived cache of resolved LinkedIn post previews. LinkedIn image
// downloadUrl values are time-limited signed URLs, so we keep the TTL well
// under their lifetime: repeat visits within the window reuse the cached
// preview without re-hitting LinkedIn, and once it lapses a fresh (re-signed)
// URL is fetched. Keyed per connection so tenants never share entries.
const LINKEDIN_PREVIEW_TTL_MS = 5 * 60 * 1000;
const linkedinPreviewCache = new Map<
  string,
  { expiresAt: number; preview: LinkedinPostPreview }
>();

async function getLinkedinPostPreviewCached(
  connId: number,
  token: string,
  postUrn: string,
): Promise<LinkedinPostPreview> {
  const key = `${connId}:${postUrn}`;
  const now = Date.now();
  const hit = linkedinPreviewCache.get(key);
  if (hit && hit.expiresAt > now) return hit.preview;
  const preview = await readLinkedinPostPreview(token, postUrn);
  // Only cache resolved previews; failures come back as all-null and should
  // be retried on the next request instead of sticking for the TTL.
  if (preview.text !== null || preview.imageUrl !== null) {
    if (linkedinPreviewCache.size > 500) {
      for (const [k, v] of linkedinPreviewCache) {
        if (v.expiresAt <= now) linkedinPreviewCache.delete(k);
      }
    }
    linkedinPreviewCache.set(key, {
      expiresAt: now + LINKEDIN_PREVIEW_TTL_MS,
      preview,
    });
  } else {
    linkedinPreviewCache.delete(key);
  }
  return preview;
}

router.get("/ads/campaign-detail", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const ct = await requireConnectedConnection(req, res);
  if (!ct) return;
  const { conn } = ct;
  const campaignId = String(req.query.campaignId ?? "");
  if (!campaignId) {
    res.status(400).json({ error: "campaignId is required" });
    return;
  }
  const datePreset = parseDatePreset(req.query.datePreset);
  try {
    if (ct.conn.platform === "linkedin") {
      // LinkedIn has no ad-set layer; creatives attached to the campaign are
      // surfaced through the shared `ads` list.
      const [campaign, creatives, metrics] = await Promise.all([
        getLinkedinCampaign(ct.token, ct.conn.adAccountId, campaignId),
        listLinkedinCreatives(ct.token, ct.conn.adAccountId, campaignId),
        getLinkedinAnalytics(ct.token, ct.conn.adAccountId, "CAMPAIGN", datePreset),
      ]);
      // Resolve each creative's backing dark post to its ad copy and image
      // (best-effort — readLinkedinPostPreview never throws). Dedupe URNs so
      // shared posts are only fetched once.
      const postUrns = [
        ...new Set(
          creatives.map((c) => c.postUrn).filter((u): u is string => !!u),
        ),
      ];
      const previews = new Map(
        await Promise.all(
          postUrns.map(
            async (urn) =>
              [
                urn,
                await getLinkedinPostPreviewCached(ct.conn.id, ct.token, urn),
              ] as const,
          ),
        ),
      );
      res.json({
        currency: ct.conn.currency ?? null,
        campaign: { ...campaign, metrics: metrics.get(campaign.id) ?? EMPTY_INSIGHTS },
        adSets: [],
        ads: creatives.map((c) => {
          const preview = c.postUrn ? previews.get(c.postUrn) : undefined;
          return {
            id: c.id,
            name: `Creative ${c.id}`,
            status: c.status,
            effectiveStatus: c.status,
            reviewStatus: c.reviewStatus,
            rejectionReasons: c.rejectionReasons,
            adSetId: null,
            text: preview?.text ?? null,
            imageUrl: preview?.imageUrl ?? null,
            metrics: EMPTY_INSIGHTS,
          };
        }),
      });
      return;
    }
    if (conn.platform === "google") {
      const auth = await getGoogleAdsAuth(conn);
      const [campaign, adGroups, googleAds] = await Promise.all([
        getGoogleCampaign(auth, campaignId, datePreset),
        listGoogleAdGroups(auth, campaignId, datePreset),
        listGoogleAds(auth, campaignId, datePreset),
      ]);
      if (!campaign) {
        res.status(404).json({ error: "Campaign not found in this Google Ads account." });
        return;
      }
      res.json({
        currency: conn.currency ?? null,
        campaign,
        adSets: adGroups,
        ads: googleAds,
      });
      return;
    }

    const token = requireMetaToken(conn, res);
    if (!token) return;

    if (ct.conn.platform === "tiktok") {
      const advertiserId = ct.conn.adAccountId;
      const [campaign, adGroups, ads, cIns, gIns, aIns] = await Promise.all([
        getTiktokCampaign(token, advertiserId, campaignId),
        listTiktokAdGroups(token, advertiserId, campaignId),
        listTiktokAds(token, advertiserId, campaignId),
        getTiktokInsightsByLevel(token, advertiserId, "campaign", datePreset),
        getTiktokInsightsByLevel(token, advertiserId, "adgroup", datePreset),
        getTiktokInsightsByLevel(token, advertiserId, "ad", datePreset),
      ]);
      // Resolve creative image IDs to thumbnail URLs (best-effort — a failed
      // lookup just leaves imageUrl null; getTiktokImageInfos never throws).
      const imageUrls = await getTiktokImageInfos(
        token,
        advertiserId,
        ads.flatMap((a) => a.imageIds),
      );
      res.json({
        currency: ct.conn.currency ?? null,
        campaign: {
          ...campaign,
          metrics: cIns.get(campaign.id) ?? EMPTY_TIKTOK_INSIGHTS,
        },
        adSets: adGroups.map((g) => ({
          ...g,
          metrics: gIns.get(g.id) ?? EMPTY_TIKTOK_INSIGHTS,
        })),
        ads: ads.map(({ imageIds, ...a }) => ({
          ...a,
          text: a.text ?? null,
          imageUrl:
            imageIds.map((id) => imageUrls.get(id)).find((u) => !!u) ?? null,
          metrics: aIns.get(a.id) ?? EMPTY_TIKTOK_INSIGHTS,
        })),
      });
      return;
    }
    const [campaign, adSets, ads, cIns, sIns, aIns] = await Promise.all([
      getCampaign(token, campaignId),
      listAdSets(token, campaignId),
      listAds(token, campaignId),
      getInsightsByLevel(token, conn.adAccountId, "campaign", datePreset),
      getInsightsByLevel(token, conn.adAccountId, "adset", datePreset),
      getInsightsByLevel(token, conn.adAccountId, "ad", datePreset),
    ]);
    res.json({
      currency: conn.currency ?? null,
      campaign: { ...campaign, metrics: cIns.get(campaign.id) ?? EMPTY_INSIGHTS },
      adSets: adSets.map((s) => ({ ...s, metrics: sIns.get(s.id) ?? EMPTY_INSIGHTS })),
      ads: ads.map((a) => ({ ...a, metrics: aIns.get(a.id) ?? EMPTY_INSIGHTS })),
    });
  } catch (err) {
    const authLost = isAdsAuthError(err);
    if (authLost) {
      await markAdConnectionAuthFailed(ct.conn, (err as Error).message);
    }
    const status = adsApiErrorStatus(err) === 404 ? 404 : 502;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Could not load the campaign.",
      ...(authLost ? { authLost: true } : {}),
    });
  }
});

/**
 * Parse a draft schedule time into epoch millis, or null when unparseable.
 * Accepts ISO date-times and TikTok's "YYYY-MM-DD HH:MM:SS" form (the TikTok
 * normalization above may already have rewritten the value into that shape).
 */
function parseScheduleTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Budget caps (optional per-tenant spend guardrails, minor units)
// ---------------------------------------------------------------------------

async function loadBudgetCaps(tenantId: number): Promise<{
  maxDailyBudget: number | null;
  maxLifetimeBudget: number | null;
}> {
  const row = (
    await db
      .select({
        maxDailyBudget: tenantsTable.adsMaxDailyBudget,
        maxLifetimeBudget: tenantsTable.adsMaxLifetimeBudget,
      })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
  return {
    maxDailyBudget: row?.maxDailyBudget ?? null,
    maxLifetimeBudget: row?.maxLifetimeBudget ?? null,
  };
}

router.get("/ads/budget-caps", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  res.json(await loadBudgetCaps(req.tenantId));
});

router.put("/ads/budget-caps", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  // Owner-only: the cap is the guardrail against everyone else's typos, so
  // only the workspace owner may raise or clear it.
  if (req.memberRole !== "owner") {
    res.status(403).json({
      error: "Only the workspace owner can change the ads budget caps.",
    });
    return;
  }
  const parsed = UpdateAdsBudgetCapsBody.safeParse(req.body);
  if (
    !parsed.success ||
    (parsed.data.maxDailyBudget != null && !Number.isInteger(parsed.data.maxDailyBudget)) ||
    (parsed.data.maxLifetimeBudget != null && !Number.isInteger(parsed.data.maxLifetimeBudget))
  ) {
    res.status(400).json({
      error: "Budget caps must be positive whole amounts in minor units, or null to clear.",
    });
    return;
  }
  await db
    .update(tenantsTable)
    .set({
      adsMaxDailyBudget: parsed.data.maxDailyBudget ?? null,
      adsMaxLifetimeBudget: parsed.data.maxLifetimeBudget ?? null,
      updatedAt: new Date(),
    })
    .where(eq(tenantsTable.id, req.tenantId));
  res.json(await loadBudgetCaps(req.tenantId));
});

// ---------------------------------------------------------------------------
// Drafts (the safety engine's front door)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Legacy campaign-group name resolution (read-time, best-effort)
//
// Newer LinkedIn drafts record the campaign group's display name in the diff
// at draft-creation time (after = name, afterDetail = raw id). Older rows only
// stored the raw id (afterDetail missing), or — for very old drafts — no
// "Campaign group" field at all despite payload.campaignGroupId. To keep the
// whole history readable, we resolve names at read time where the connection
// can still list its campaign groups, falling back to the stored raw id.
// ---------------------------------------------------------------------------

const CAMPAIGN_GROUP_FIELD = "Campaign group";

type ChangeField = AdChangeRequest["changes"][number];

/** Raw group id when a diff has a legacy (name-less) Campaign group field. */
function legacyGroupIdInChanges(changes: ChangeField[]): string | null {
  const f = changes.find((c) => c.field === CAMPAIGN_GROUP_FIELD);
  if (!f || f.afterDetail || !f.after) return null;
  return f.after;
}

/** Raw group id a legacy draft needs resolved, or null when none needed. */
function draftLegacyGroupId(d: AdChangeRequest): string | null {
  if (d.platform !== "linkedin") return null;
  const inChanges = legacyGroupIdInChanges(d.changes);
  if (inChanges) return inChanges;
  if (d.changes.some((c) => c.field === CAMPAIGN_GROUP_FIELD)) return null;
  const pid = d.payload?.campaignGroupId;
  return d.action === "create" && d.targetType === "campaign" && typeof pid === "string"
    ? pid
    : null;
}

// Short in-process cache of campaign-group listings per LinkedIn connection
// so repeated drafts/change-log page loads don't re-hit LinkedIn's API.
// Successful lookups only; failures are never cached (raw id stays the
// fallback and the next read retries).
const LINKEDIN_GROUP_NAMES_TTL_MS = 5 * 60 * 1000;
const linkedinGroupNamesCache = new Map<
  number,
  { expiresAt: number; groups: Array<{ id: string; name: string }> }
>();

/** Test-only: clear the campaign-group name cache. */
export function clearLinkedinGroupNamesCache(): void {
  linkedinGroupNamesCache.clear();
}

/**
 * Best-effort: list campaign groups for the tenant's LinkedIn connections and
 * build an id -> name map. `connectionIds` limits which connections are
 * queried (null = all). Any failure just yields fewer names — the stored raw
 * id remains the fallback. Results are cached per connection for a few
 * minutes to avoid re-hitting LinkedIn on every page load.
 */
async function loadLinkedinGroupNames(
  tenantId: number,
  connectionIds: Set<number> | null,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const conns = await db
    .select()
    .from(adAccountConnectionsTable)
    .where(
      and(
        eq(adAccountConnectionsTable.tenantId, tenantId),
        eq(adAccountConnectionsTable.platform, "linkedin"),
      ),
    );
  for (const conn of conns) {
    if (connectionIds && !connectionIds.has(conn.id)) continue;
    if (conn.status !== "connected" || !conn.encryptedCredentials) continue;
    const cached = linkedinGroupNamesCache.get(conn.id);
    if (cached && cached.expiresAt > Date.now()) {
      for (const g of cached.groups) {
        if (!names.has(g.id)) names.set(g.id, g.name);
      }
      continue;
    }
    try {
      const token = getConnectionToken(conn);
      if (!token) continue;
      const groups = await listLinkedinCampaignGroups(token, conn.adAccountId);
      linkedinGroupNamesCache.set(conn.id, {
        expiresAt: Date.now() + LINKEDIN_GROUP_NAMES_TTL_MS,
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
      });
      for (const g of groups) {
        if (!names.has(g.id)) names.set(g.id, g.name);
      }
    } catch {
      // Cosmetic lookup only — never fail the read.
    }
  }
  return names;
}

/** Rewrite legacy Campaign group fields to name + raw-id detail when known. */
function withResolvedGroupNames(
  changes: ChangeField[],
  names: Map<string, string>,
): ChangeField[] {
  return changes.map((c) => {
    if (c.field !== CAMPAIGN_GROUP_FIELD || c.afterDetail || !c.after) return c;
    const name = names.get(c.after);
    if (!name) return c;
    return { ...c, after: name, afterDetail: c.after };
  });
}

/** Draft changes with the group field enriched (and added when missing). */
function enrichedDraftChanges(
  d: AdChangeRequest,
  names: Map<string, string>,
): ChangeField[] {
  let changes = withResolvedGroupNames(d.changes, names);
  const pid = draftLegacyGroupId(d);
  if (pid && !changes.some((c) => c.field === CAMPAIGN_GROUP_FIELD)) {
    const name = names.get(pid) ?? null;
    const groupField: ChangeField = {
      field: CAMPAIGN_GROUP_FIELD,
      before: null,
      after: name ?? pid,
      afterDetail: name ? pid : null,
    };
    // Match buildCreateDiff ordering: Name, Status, Campaign group, ...
    changes = [...changes.slice(0, 2), groupField, ...changes.slice(2)];
  }
  return changes;
}

router.get("/ads/drafts", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const rows = await db
    .select()
    .from(adChangeRequestsTable)
    .where(eq(adChangeRequestsTable.tenantId, req.tenantId))
    .orderBy(desc(adChangeRequestsTable.createdAt))
    .limit(100);

  // Resolve legacy raw-id campaign group references at read time.
  const needConnIds = new Set<number>();
  for (const r of rows) {
    if (draftLegacyGroupId(r)) needConnIds.add(r.connectionId);
  }
  const groupNames = needConnIds.size
    ? await loadLinkedinGroupNames(req.tenantId, needConnIds)
    : new Map<string, string>();

  const pending = rows.filter((r) => r.status === "draft");
  const rest = rows.filter((r) => r.status !== "draft");
  res.json(
    [...pending, ...rest].map((r) =>
      serializeDraft(
        // Run enrichment for any row needing legacy handling even when no
        // names could be resolved, so very old drafts with no Campaign group
        // field still get one inserted with the raw id as the fallback.
        draftLegacyGroupId(r)
          ? { ...r, changes: enrichedDraftChanges(r, groupNames) }
          : r,
      ),
    ),
  );
});

/**
 * Best-effort lookup of a LinkedIn campaign group's display name so draft
 * diffs show a name instead of a raw id. Returns null on any failure — the
 * draft must never be blocked by a cosmetic lookup.
 */
async function lookupLinkedinGroupName(
  conn: AdAccountConnection,
  campaignGroupId: string,
): Promise<string | null> {
  if (conn.platform !== "linkedin") return null;
  try {
    const token = getConnectionToken(conn);
    if (!token) return null;
    const groups = await listLinkedinCampaignGroups(token, conn.adAccountId);
    return groups.find((g) => g.id === campaignGroupId)?.name ?? null;
  } catch {
    return null;
  }
}

router.post(
  "/ads/drafts",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const parsed = CreateAdDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid draft", details: parsed.error.issues });
      return;
    }
    const input = parsed.data;

    const conn = await getAdConnection(req.tenantId, input.connectionId);
    if (!conn || conn.status !== "connected" || !conn.encryptedCredentials) {
      res.status(400).json({
        error: "This ad account connection is missing or needs reconnecting.",
      });
      return;
    }

    // Campaigns can be created and fully edited; LinkedIn additionally
    // supports creating campaign groups and creatives (sponsored content).
    // Ad sets and ads are update-only, each restricted to the fields the
    // object actually has.
    if (input.targetType === "campaign_group") {
      if (conn.platform !== "linkedin") {
        res.status(400).json({ error: "Campaign groups are only supported on LinkedIn." });
        return;
      }
      if (input.dailyBudget != null || input.startTime != null || input.stopTime != null) {
        res.status(400).json({
          error: "Campaign groups support a name, status, and an optional lifetime budget only.",
        });
        return;
      }
      if (input.removeLifetimeBudget && input.action !== "update") {
        res.status(400).json({
          error: "A lifetime budget can only be removed from an existing campaign group.",
        });
        return;
      }
      if (input.removeLifetimeBudget && input.lifetimeBudget != null) {
        res.status(400).json({
          error:
            "Choose one: set a new lifetime budget, or remove it — not both.",
        });
        return;
      }
    } else if (input.removeLifetimeBudget) {
      res.status(400).json({
        error: "Removing a lifetime budget is only supported for LinkedIn campaign groups.",
      });
      return;
    } else if (input.targetType === "creative") {
      if (conn.platform !== "linkedin") {
        res.status(400).json({ error: "Creatives are only supported on LinkedIn." });
        return;
      }
      if (input.action === "update") {
        // Live creatives are status-only: activate, pause, or archive.
        if (
          input.name != null ||
          input.dailyBudget != null ||
          input.lifetimeBudget != null ||
          input.startTime != null ||
          input.stopTime != null ||
          input.text != null ||
          input.imagePath != null ||
          input.landingUrl != null ||
          input.campaignId != null
        ) {
          res.status(400).json({
            error:
              "LinkedIn creatives only support status changes (activate, pause, or archive).",
          });
          return;
        }
        if (!input.status) {
          res.status(400).json({ error: "status is required to update a creative" });
          return;
        }
      }
    } else if (input.action === "create" && input.targetType !== "campaign") {
      res.status(400).json({ error: "Only campaigns can be created in this phase." });
      return;
    }
    // Targeting facets: locations may accompany creates (legacy behavior);
    // industries/job functions/titles are update-only replacements. An empty
    // array clears a facet (except locations, which LinkedIn requires).
    const rawFacetInputs: Record<LinkedinTargetingFacetKey, typeof input.targetingLocations> = {
      locations: input.targetingLocations?.length ? input.targetingLocations : undefined,
      industries: input.targetingIndustries,
      jobFunctions: input.targetingJobFunctions,
      titles: input.targetingTitles,
    };
    const hasTargetingInput = Object.values(rawFacetInputs).some((v) => v != null);
    if (hasTargetingInput && (conn.platform !== "linkedin" || input.targetType !== "campaign")) {
      res.status(400).json({
        error: "Audience targeting is only supported on LinkedIn campaigns.",
      });
      return;
    }
    if (
      input.action !== "update" &&
      (rawFacetInputs.industries != null ||
        rawFacetInputs.jobFunctions != null ||
        rawFacetInputs.titles != null)
    ) {
      res.status(400).json({
        error:
          "Industry, job function, and job title targeting can only be changed on an existing campaign.",
      });
      return;
    }
    const proposedFacets: ProposedTargetingFacets = {};
    for (const key of LINKEDIN_TARGETING_FACET_KEYS) {
      const raw = rawFacetInputs[key];
      if (raw == null) continue;
      const entities = raw.map((l) => ({ urn: l.urn.trim(), name: l.name.trim() }));
      const bad = entities.find(
        (l) => !LINKEDIN_TARGETING_FACETS[key].entityPattern.test(l.urn) || !l.name,
      );
      if (bad) {
        res.status(400).json({
          error: `Each entry under targeted ${LINKEDIN_TARGETING_FACETS[key].label} needs a valid LinkedIn URN and a name. Pick entries from the search results.`,
        });
        return;
      }
      proposedFacets[key] = entities;
    }
    const targetingLocations: TargetingLocation[] | null =
      proposedFacets.locations?.length ? proposedFacets.locations : null;
    if (input.action === "update" && !input.targetId) {
      res.status(400).json({ error: "targetId is required for updates" });
      return;
    }
    // ARCHIVED is only valid for LinkedIn creatives and Meta ads; every other
    // object supports ACTIVE and PAUSED only.
    if (
      input.status === "ARCHIVED" &&
      !(input.targetType === "creative" && input.action === "update") &&
      !(
        input.targetType === "ad" &&
        input.action === "update" &&
        conn.platform === "meta"
      )
    ) {
      res.status(400).json({
        error:
          "Only LinkedIn creatives and Meta ads can be archived — other objects support ACTIVE and PAUSED.",
      });
      return;
    }
    if (conn.platform === "tiktok") {
      // TikTok campaigns carry no schedule — start/end dates live on ad
      // groups, where schedule edits ARE supported.
      if (
        input.targetType === "campaign" &&
        (input.startTime != null || input.stopTime != null)
      ) {
        res.status(400).json({
          error:
            "TikTok campaigns do not have a schedule — start and end dates are set on ad groups.",
        });
        return;
      }
      if (input.targetType === "adset") {
        if (input.stopTime != null && input.startTime == null) {
          res.status(400).json({
            error:
              "TikTok needs a start time to set an end time on an ad group. Set both, or only the start.",
          });
          return;
        }
        // Normalize to TikTok's own time format up front so the stored
        // payload matches the read-back verify exactly.
        try {
          if (input.startTime != null) input.startTime = toTiktokTime(input.startTime);
          if (input.stopTime != null) input.stopTime = toTiktokTime(input.stopTime);
        } catch (err) {
          res.status(400).json({
            error: err instanceof Error ? err.message : "Invalid schedule time.",
          });
          return;
        }
      }
      // TikTok enforces platform budget minimums (campaign >= 50, ad group
      // >= 20 in major units). Reject below-minimum budgets HERE (draft
      // creation) so the owner never approves a draft that can only fail at
      // apply time with a raw platform error.
      if (input.targetType === "campaign" || input.targetType === "adset") {
        const minMinor =
          input.targetType === "campaign"
            ? TIKTOK_MIN_CAMPAIGN_BUDGET_MINOR
            : TIKTOK_MIN_ADGROUP_BUDGET_MINOR;
        const noun = input.targetType === "campaign" ? "campaign" : "ad group";
        for (const [label, value] of [
          ["daily", input.dailyBudget],
          ["lifetime", input.lifetimeBudget],
        ] as const) {
          if (value != null && value < minMinor) {
            res.status(400).json({
              error: `TikTok requires a ${noun} ${label} budget of at least ${minMinor / 100} (in the ad account's currency). Raise the budget${input.targetType === "campaign" ? ", or leave it blank for an unlimited campaign budget" : ""}.`,
            });
            return;
          }
        }
      }
    }

    if (conn.platform === "google" && input.lifetimeBudget != null) {
      res.status(400).json({
        error:
          "Lifetime budgets are not supported on Google Ads. Use a daily budget instead.",
      });
      return;
    }
    if (
      conn.platform === "google" &&
      input.targetType === "ad" &&
      input.name != null
    ) {
      res.status(400).json({
        error:
          "Google ads can only be paused or activated here — renaming an ad is not supported.",
      });
      return;
    }
    if (input.targetType === "ad" &&
      (input.dailyBudget != null || input.lifetimeBudget != null ||
        input.startTime != null || input.stopTime != null)) {
      res.status(400).json({
        error: "Ads only support name and status changes — budgets and schedules live on the ad set.",
      });
      return;
    }
    // Ad set schedule edits are supported on Meta (mapped to the ad set's
    // end_time/start_time fields) and TikTok (ad group schedule);
    // other platforms still reject them.
    if (
      input.targetType === "adset" &&
      conn.platform !== "meta" &&
      conn.platform !== "tiktok" &&
      (input.startTime != null || input.stopTime != null)
    ) {
      res.status(400).json({
        error: "Ad set schedule changes are only supported on Meta and TikTok — other platforms allow name, status, and budgets only.",
      });
      return;
    }
    // Schedule sanity guardrail: reject unparseable times and end <= start
    // HERE (draft creation, like the budget caps below) so an obviously
    // invalid schedule never reaches the owner's approval queue. The
    // adapter-level checks remain as a backstop at apply time.
    if (input.startTime != null || input.stopTime != null) {
      const startMs =
        input.startTime != null ? parseScheduleTime(input.startTime) : null;
      if (input.startTime != null && startMs == null) {
        res.status(400).json({
          error: `Could not understand the start time "${input.startTime}". Use an ISO date-time like 2026-08-01T00:00:00.`,
        });
        return;
      }
      const stopMs =
        input.stopTime != null ? parseScheduleTime(input.stopTime) : null;
      if (input.stopTime != null && stopMs == null) {
        res.status(400).json({
          error: `Could not understand the end time "${input.stopTime}". Use an ISO date-time like 2026-08-01T00:00:00.`,
        });
        return;
      }
      if (startMs != null && stopMs != null && stopMs <= startMs) {
        res.status(400).json({
          error: "The schedule's end time must be after its start time.",
        });
        return;
      }
    }

    // Bid tuning (amount/strategy) is a Meta ad-set update knob only.
    if (input.bidAmount != null || input.bidStrategy != null) {
      if (
        conn.platform !== "meta" ||
        input.targetType !== "adset" ||
        input.action !== "update"
      ) {
        res.status(400).json({
          error: "Bid changes are only supported for Meta ad set updates.",
        });
        return;
      }
      if (
        input.bidAmount != null &&
        (!Number.isFinite(input.bidAmount) || input.bidAmount <= 0)
      ) {
        res.status(400).json({
          error: "The bid amount must be a positive number of minor currency units.",
        });
        return;
      }
      if (input.bidStrategy === "LOWEST_COST_WITHOUT_CAP" && input.bidAmount != null) {
        res.status(400).json({
          error:
            "LOWEST_COST_WITHOUT_CAP does not take a bid amount — remove the bid amount or pick a cap strategy.",
        });
        return;
      }
      if (
        (input.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ||
          input.bidStrategy === "COST_CAP") &&
        input.bidAmount == null
      ) {
        res.status(400).json({
          error: `${input.bidStrategy} requires a bid amount in minor currency units.`,
        });
        return;
      }
    }

    // Spend guardrail: reject drafts whose proposed budget exceeds the
    // workspace's caps. Enforced HERE (draft creation) so an over-cap typo
    // never even reaches the owner's approval queue.
    const caps = await loadBudgetCaps(req.tenantId);
    if (
      caps.maxDailyBudget != null &&
      input.dailyBudget != null &&
      input.dailyBudget > caps.maxDailyBudget
    ) {
      res.status(400).json({
        error: `The proposed daily budget (${input.dailyBudget} minor units) exceeds this workspace's daily budget cap of ${caps.maxDailyBudget}. Lower the budget, or ask the workspace owner to raise the cap.`,
      });
      return;
    }
    if (
      caps.maxLifetimeBudget != null &&
      input.lifetimeBudget != null &&
      input.lifetimeBudget > caps.maxLifetimeBudget
    ) {
      res.status(400).json({
        error: `The proposed lifetime budget (${input.lifetimeBudget} minor units) exceeds this workspace's lifetime budget cap of ${caps.maxLifetimeBudget}. Lower the budget, or ask the workspace owner to raise the cap.`,
      });
      return;
    }

    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();
    const existing = (
      await db
        .select()
        .from(adChangeRequestsTable)
        .where(
          and(
            eq(adChangeRequestsTable.tenantId, req.tenantId),
            eq(adChangeRequestsTable.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
    )[0];
    if (existing) {
      res.status(409).json(serializeDraft(existing));
      return;
    }

    let changes;
    let beforeSnapshot: Record<string, unknown> | null = null;
    let targetName: string;
    const payload: Record<string, unknown> = {};
    if (input.name != null) payload.name = input.name;
    if (input.status != null) payload.status = input.status;
    if (input.dailyBudget != null) payload.dailyBudget = input.dailyBudget;
    if (input.lifetimeBudget != null) payload.lifetimeBudget = input.lifetimeBudget;
    if (input.removeLifetimeBudget) payload.removeLifetimeBudget = true;
    if (input.startTime != null) payload.startTime = input.startTime;
    if (input.stopTime != null) payload.stopTime = input.stopTime;
    if (input.bidAmount != null) payload.bidAmount = input.bidAmount;
    if (input.bidStrategy != null) payload.bidStrategy = input.bidStrategy;
    if (targetingLocations) payload.targetingLocations = targetingLocations;

    if (input.targetType === "creative" && input.action === "create") {
      // Creative create: attach sponsored content (text + optional library
      // image + optional landing URL) to an existing LinkedIn campaign.
      const campaignId = input.campaignId?.trim();
      if (!campaignId) {
        res.status(400).json({ error: "campaignId is required to create a creative" });
        return;
      }
      const text = input.text?.trim();
      if (!text) {
        res.status(400).json({ error: "text is required to create a creative" });
        return;
      }
      const imagePath = input.imagePath?.trim() || null;
      if (imagePath && !imagePath.startsWith(`/objects/${req.tenantId}/`)) {
        // Tenant boundary: the path must belong to this workspace's storage
        // namespace; anything else is rejected without confirming existence.
        res.status(400).json({ error: "imagePath must be an image from your content library." });
        return;
      }
      const landingUrl = input.landingUrl?.trim() || null;
      if (landingUrl) {
        let parsed: URL;
        try {
          parsed = new URL(landingUrl);
        } catch {
          res.status(400).json({ error: "landingUrl must be a valid URL." });
          return;
        }
        if (parsed.protocol !== "https:") {
          res.status(400).json({ error: "landingUrl must use https." });
          return;
        }
      }
      let campaignName = campaignId;
      const liToken = getConnectionToken(conn);
      if (!liToken) {
        res.status(400).json({
          error: "This ad account connection is missing or needs reconnecting.",
        });
        return;
      }
      try {
        const campaign = await getLinkedinCampaign(liToken, conn.adAccountId, campaignId);
        campaignName = campaign.name || campaignId;
      } catch (err) {
        if (isAdsAuthError(err)) {
          await markAdConnectionFailed(conn.id, (err as Error).message);
        }
        res.status(502).json({
          error:
            err instanceof Error
              ? `Could not read the campaign: ${err.message}`
              : "Could not read the campaign.",
        });
        return;
      }
      payload.campaignId = campaignId;
      payload.text = text;
      if (imagePath) payload.imagePath = imagePath;
      if (landingUrl) payload.landingUrl = landingUrl;
      if (payload.status == null) payload.status = "PAUSED";
      const targetName =
        text.length > 60 ? `${text.slice(0, 57)}...` : text;
      const changes = buildCreativeCreateDiff({
        campaignName,
        text,
        imagePath,
        landingUrl,
        status: (payload.status as string) ?? "PAUSED",
      });
      const draft = (
        await db
          .insert(adChangeRequestsTable)
          .values({
            tenantId: req.tenantId,
            connectionId: conn.id,
            platform: conn.platform,
            targetType: "creative",
            targetId: null,
            targetName,
            action: "create",
            changes,
            payload,
            beforeSnapshot: null,
            status: "draft",
            idempotencyKey,
            createdByClerkUserId: req.clerkUserId,
            createdByEmail: req.tenantEmail ?? null,
          })
          .returning()
      )[0]!;
      if (req.memberRole !== "owner") {
        const owner = (
          await db
            .select({ clerkUserId: tenantsTable.clerkUserId })
            .from(tenantsTable)
            .where(eq(tenantsTable.id, req.tenantId))
            .limit(1)
        )[0];
        await notifyAdsDraftPending(
          req.tenantId,
          owner?.clerkUserId ?? null,
          targetName,
          conn.platform,
        );
      }
      res.status(201).json(serializeDraft(draft));
      return;
    }

    if (input.action === "update") {
      let current;
      try {
        current = await readAdTargetState(conn, input.targetId!, asDraftTargetType(input.targetType));
      } catch (err) {
        if (isAdsAuthError(err)) {
          await markAdConnectionAuthFailed(conn, (err as Error).message);
        }
        res.status(502).json({
          error:
            err instanceof Error
              ? `Could not read the current state: ${err.message}`
              : "Could not read the current state.",
        });
        return;
      }
      targetName = current.name || (input.name ?? "");
      changes = buildUpdateDiff(current, {
        name: input.name,
        status: input.status,
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        removeLifetimeBudget: input.removeLifetimeBudget,
        startTime: input.startTime,
        stopTime: input.stopTime,
        targetingFacets: proposedFacets,
        bidAmount: input.bidAmount,
        bidStrategy: input.bidStrategy,
        targetingLocations,
      }, { platform: conn.platform });
      if (changes.length === 0) {
        res.status(400).json({
          error: "Nothing would change — the proposed values match the current state.",
        });
        return;
      }
      beforeSnapshot = snapshotForCompare(current);
      if (hasTargetingInput) {
        // The apply replaces the campaign's whole targetingCriteria, so store
        // the FULL per-facet URN sets: the proposed facets plus the current
        // values of every untouched facet. The drift check guarantees the
        // remote state still matches this snapshot at apply time.
        const merged: Record<string, string[]> = {
          locations: proposedFacets.locations?.length
            ? sortedUrns(proposedFacets.locations)
            : current.targetingLocations ?? [],
          industries:
            proposedFacets.industries != null
              ? sortedUrns(proposedFacets.industries)
              : current.targetingIndustries ?? [],
          jobFunctions:
            proposedFacets.jobFunctions != null
              ? sortedUrns(proposedFacets.jobFunctions)
              : current.targetingJobFunctions ?? [],
          titles:
            proposedFacets.titles != null
              ? sortedUrns(proposedFacets.titles)
              : current.targetingTitles ?? [],
        };
        if (merged.locations.length === 0) {
          res.status(400).json({
            error:
              "This change would leave the campaign with no target locations. LinkedIn requires every campaign to target at least one location — add a replacement location instead of only removing them.",
          });
          return;
        }
        payload.targetingFacets = merged;
        delete payload.targetingLocations;
      }
    } else {
      if (!input.name?.trim()) {
        res.status(400).json({
          error: `name is required to create a ${input.targetType === "campaign_group" ? "campaign group" : "campaign"}`,
        });
        return;
      }
      if (conn.platform === "linkedin") {
        if (input.targetType === "campaign") {
          if (!input.campaignGroupId?.trim()) {
            res.status(400).json({
              error: "campaignGroupId is required to create a LinkedIn campaign",
            });
            return;
          }
          payload.campaignGroupId = input.campaignGroupId.trim();
        }
      } else if (input.objective != null) {
        payload.objective = input.objective;
      }
      targetName = input.name.trim();
      changes = buildCreateDiff({
        campaignGroup:
          typeof payload.campaignGroupId === "string"
            ? {
                id: payload.campaignGroupId,
                name: await lookupLinkedinGroupName(conn, payload.campaignGroupId),
              }
            : null,
        name: targetName,
        objective:
          conn.platform === "linkedin" || input.targetType === "campaign_group"
            ? undefined
            : input.objective ?? defaultAdsObjective(conn.platform),
        status: input.status ?? "PAUSED",
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        startTime: input.startTime,
        stopTime: input.stopTime,
      });
    }

    const draft = (
      await db
        .insert(adChangeRequestsTable)
        .values({
          tenantId: req.tenantId,
          connectionId: conn.id,
          platform: conn.platform,
          targetType: input.targetType,
          targetId: input.action === "update" ? input.targetId : null,
          targetName,
          action: input.action,
          changes,
          payload,
          beforeSnapshot,
          status: "draft",
          idempotencyKey,
          createdByClerkUserId: req.clerkUserId,
          createdByEmail: req.tenantEmail ?? null,
        })
        .returning()
    )[0]!;

    // Approval is owner-only; when someone else drafts, ping the owner.
    if (req.memberRole !== "owner") {
      const owner = (
        await db
          .select({ clerkUserId: tenantsTable.clerkUserId })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, req.tenantId))
          .limit(1)
      )[0];
      await notifyAdsDraftPending(
        req.tenantId,
        owner?.clerkUserId ?? null,
        targetName,
        conn.platform,
      );
    }

    res.status(201).json(serializeDraft(draft));
  },
);

router.post("/ads/drafts/:id/approve", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  if (req.memberRole !== "owner") {
    res.status(403).json({
      error: "Only the workspace owner can approve and apply advertising changes.",
    });
    return;
  }
  // Spend guardrail, re-checked at approval time: a draft created before the
  // owner tightened the caps must not be able to spend over the CURRENT cap.
  // Checked here (before the engine claims the draft) so the draft stays in
  // 'draft' status and can be rejected/recreated instead of ending up failed.
  const pending = (
    await db
      .select()
      .from(adChangeRequestsTable)
      .where(
        and(
          eq(adChangeRequestsTable.id, Number(req.params.id)),
          eq(adChangeRequestsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (pending && pending.status === "draft") {
    const payload = (pending.payload ?? {}) as {
      dailyBudget?: unknown;
      lifetimeBudget?: unknown;
    };
    const caps = await loadBudgetCaps(req.tenantId);
    if (
      caps.maxDailyBudget != null &&
      typeof payload.dailyBudget === "number" &&
      payload.dailyBudget > caps.maxDailyBudget
    ) {
      res.status(400).json({
        error: `This draft's daily budget (${payload.dailyBudget} minor units) exceeds this workspace's current daily budget cap of ${caps.maxDailyBudget}. Raise the cap, or reject this draft and create a new one within the cap.`,
      });
      return;
    }
    if (
      caps.maxLifetimeBudget != null &&
      typeof payload.lifetimeBudget === "number" &&
      payload.lifetimeBudget > caps.maxLifetimeBudget
    ) {
      res.status(400).json({
        error: `This draft's lifetime budget (${payload.lifetimeBudget} minor units) exceeds this workspace's current lifetime budget cap of ${caps.maxLifetimeBudget}. Raise the cap, or reject this draft and create a new one within the cap.`,
      });
      return;
    }
  }
  const result = await approveAndApplyDraft(req.tenantId, Number(req.params.id), {
    clerkUserId: req.clerkUserId,
    email: req.tenantEmail ?? null,
  });
  switch (result.kind) {
    case "not_found":
      res.status(404).json({ error: "Draft not found" });
      return;
    case "conflict":
      res.status(409).json({ error: ADS_APPLY_IN_PROGRESS_MESSAGE });
      return;
    case "bad_status": {
      // Idempotent replay: return the draft in its final state.
      const row = (
        await db
          .select()
          .from(adChangeRequestsTable)
          .where(
            and(
              eq(adChangeRequestsTable.id, Number(req.params.id)),
              eq(adChangeRequestsTable.tenantId, req.tenantId),
            ),
          )
          .limit(1)
      )[0];
      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      res.json(serializeDraft(row));
      return;
    }
    default:
      // A failed apply caused by a revoked/expired grant carries `authLost` so
      // the client can refetch connections and show the Reconnect prompt
      // immediately (the server already marked the connection failed).
      res.json({
        ...serializeDraft(result.draft),
        ...(result.kind === "failed" && result.authLost ? { authLost: true } : {}),
      });
  }
});

router.post(
  "/ads/drafts/:id/reject",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    if (!(await adsEnabledOr503(res))) return;
    const updated = (
      await db
        .update(adChangeRequestsTable)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(adChangeRequestsTable.id, Number(req.params.id)),
            eq(adChangeRequestsTable.tenantId, req.tenantId),
            eq(adChangeRequestsTable.status, "draft"),
          ),
        )
        .returning()
    )[0];
    if (!updated) {
      const row = (
        await db
          .select()
          .from(adChangeRequestsTable)
          .where(
            and(
              eq(adChangeRequestsTable.id, Number(req.params.id)),
              eq(adChangeRequestsTable.tenantId, req.tenantId),
            ),
          )
          .limit(1)
      )[0];
      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      res.status(400).json({ error: `This draft is already ${row.status}.` });
      return;
    }
    res.json(serializeDraft(updated));
  },
);

router.get("/ads/change-log", async (req: Request, res: Response) => {
  if (!(await adsEnabledOr503(res))) return;
  const rows = await db
    .select()
    .from(adsChangeLogsTable)
    .where(eq(adsChangeLogsTable.tenantId, req.tenantId))
    .orderBy(desc(adsChangeLogsTable.createdAt))
    .limit(200);

  // Resolve legacy raw-id campaign group references at read time. Log rows
  // don't record a connection id, so consult all the tenant's LinkedIn
  // connections.
  const needsResolution = rows.some(
    (r) => r.platform === "linkedin" && legacyGroupIdInChanges(r.changes) != null,
  );
  const groupNames = needsResolution
    ? await loadLinkedinGroupNames(req.tenantId, null)
    : new Map<string, string>();

  res.json(
    rows.map((r) =>
      serializeLogEntry(
        groupNames.size
          ? { ...r, changes: withResolvedGroupNames(r.changes, groupNames) }
          : r,
      ),
    ),
  );
});

// ---------------------------------------------------------------------------
// Admin: global switch + platform readiness (superadmin only, audited)
// ---------------------------------------------------------------------------

async function adminSettingsPayload() {
  const [enabled, platforms] = await Promise.all([
    getAdsModuleEnabled(),
    getAdsPlatformAvailability(),
  ]);
  return {
    enabled,
    platforms: platforms.map((p) => ({
      platform: p.platform,
      configured: p.available,
      note:
        p.platform === "meta"
          ? "Reuses the Meta app credentials saved under Platform credentials."
          : p.platform === "linkedin"
            ? "Reuses the LinkedIn app credentials saved under Platform credentials."
            : p.platform === "google"
              ? "Uses the Google Ads credentials (OAuth client + developer token) saved under Platform credentials."
              : p.platform === "tiktok"
                ? "Uses the TikTok for Business app credentials saved under Platform credentials."
                : "Coming later — no credential slot yet.",
    })),
  };
}

router.get(
  "/admin/ads/settings",
  requireSuperadmin,
  async (_req: Request, res: Response) => {
    res.json(await adminSettingsPayload());
  },
);

router.put(
  "/admin/ads/settings",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = AdminUpdateAdsSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    const before = await getAdsModuleEnabled();
    if (before !== parsed.data.enabled) {
      await setAdsModuleEnabled(parsed.data.enabled);
      try {
        await recordAdminAction({
          action: "ads_module_toggled",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail ?? null,
          targetTenantId: null,
          targetEmail: null,
          oldValue: before ? "enabled" : "disabled",
          newValue: parsed.data.enabled ? "enabled" : "disabled",
        });
      } catch (err) {
        req.log.error({ err }, "Failed to audit ads settings change");
      }
    }
    res.json(await adminSettingsPayload());
  },
);

export default router;
