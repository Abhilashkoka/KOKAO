import {
  db,
  signupCreditSettingsTable,
  tenantsTable,
  creditBalancesTable,
  creditLedgerTable,
  type SignupCreditSettings,
} from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { logger } from "./logger";
import { isFeatureEnabled } from "./featureFlags";
import { notifySignupCreditsGranted } from "./notifications";

/**
 * Automatic signup credit grant: a superadmin-configured bundle of
 * caption/image/video credits handed to every brand-new workspace exactly
 * once, at first provisioning.
 *
 * Two independent switches must BOTH be on for a grant to happen:
 *   1. the `signupCredits` platform feature flag (kill switch), and
 *   2. the `enabled` flag on the signup_credit_settings row.
 *
 * Once-only guarantee: the grant transaction flips
 * `tenants.signup_credits_granted_at` NULL -> now() with a conditional
 * UPDATE ... RETURNING; only the request that wins that flip grants credits,
 * so concurrent first requests can never double-grant.
 */

export interface SignupCreditSettingsView {
  enabled: boolean;
  captionCredits: number;
  imageCredits: number;
  videoCredits: number;
}

const DEFAULTS: SignupCreditSettingsView = {
  enabled: false,
  captionCredits: 0,
  imageCredits: 0,
  videoCredits: 0,
};

/** Singleton row: always id=1 (enforced by the fixed-id upsert below). */
const SETTINGS_ROW_ID = 1;

async function loadRow(): Promise<SignupCreditSettings | undefined> {
  return (
    await db
      .select()
      .from(signupCreditSettingsTable)
      .where(eq(signupCreditSettingsTable.id, SETTINGS_ROW_ID))
      .limit(1)
  )[0];
}

export async function getSignupCreditSettings(): Promise<SignupCreditSettingsView> {
  const row = await loadRow();
  if (!row) return { ...DEFAULTS };
  return {
    enabled: row.enabled,
    captionCredits: row.captionCredits,
    imageCredits: row.imageCredits,
    videoCredits: row.videoCredits,
  };
}

export async function updateSignupCreditSettings(
  input: SignupCreditSettingsView,
): Promise<SignupCreditSettingsView> {
  // Single-statement upsert on the fixed id so concurrent first-time saves
  // can never create more than one settings row.
  await db
    .insert(signupCreditSettingsTable)
    .values({
      id: SETTINGS_ROW_ID,
      enabled: input.enabled,
      captionCredits: input.captionCredits,
      imageCredits: input.imageCredits,
      videoCredits: input.videoCredits,
    })
    .onConflictDoUpdate({
      target: signupCreditSettingsTable.id,
      set: {
        enabled: input.enabled,
        captionCredits: input.captionCredits,
        imageCredits: input.imageCredits,
        videoCredits: input.videoCredits,
        updatedAt: new Date(),
      },
    });
  return getSignupCreditSettings();
}

/**
 * Grant the configured signup bundle to a freshly provisioned workspace.
 * Called from the provisioning path right after the tenant insert wins.
 * Best-effort: any failure is logged and NEVER fails provisioning.
 *
 * Returns true when a grant was applied (useful for tests).
 */
export async function maybeGrantSignupCredits(tenantId: number): Promise<boolean> {
  try {
    // Kill switch first: turning the feature off stops all future grants
    // immediately, regardless of the configured settings row.
    if (!(await isFeatureEnabled("signupCredits"))) return false;

    const settings = await getSignupCreditSettings();
    if (!settings.enabled) return false;
    const captions = Math.max(0, settings.captionCredits);
    const images = Math.max(0, settings.imageCredits);
    const videos = Math.max(0, settings.videoCredits);
    if (captions === 0 && images === 0 && videos === 0) return false;

    const granted = await db.transaction(async (tx) => {
      // Once-only guard: only the request that flips the column grants.
      const claimed = (
        await tx
          .update(tenantsTable)
          .set({ signupCreditsGrantedAt: new Date() })
          .where(
            and(
              eq(tenantsTable.id, tenantId),
              isNull(tenantsTable.signupCreditsGrantedAt),
            ),
          )
          .returning({ id: tenantsTable.id })
      )[0];
      if (!claimed) return false;

      const balance = (
        await tx
          .select()
          .from(creditBalancesTable)
          .where(eq(creditBalancesTable.tenantId, tenantId))
          .for("update")
      )[0];
      const newCaptions = (balance?.captionCredits ?? 0) + captions;
      const newImages = (balance?.imageCredits ?? 0) + images;
      const newVideos = (balance?.videoCredits ?? 0) + videos;
      await tx.insert(creditLedgerTable).values({
        tenantId,
        kind: "signup_bonus",
        captionDelta: captions,
        imageDelta: images,
        videoDelta: videos,
        note: "Welcome signup bonus",
      });
      if (balance) {
        await tx
          .update(creditBalancesTable)
          .set({
            captionCredits: newCaptions,
            imageCredits: newImages,
            videoCredits: newVideos,
          })
          .where(eq(creditBalancesTable.tenantId, tenantId));
      } else {
        await tx.insert(creditBalancesTable).values({
          tenantId,
          captionCredits: newCaptions,
          imageCredits: newImages,
          videoCredits: newVideos,
        });
      }
      return true;
    });

    if (granted) {
      // One-time welcome notice so the bonus isn't invisible. Fired only by
      // the request that won the once-only grant, so it can never repeat and
      // never fires for workspaces that received no grant. Best-effort.
      await notifySignupCreditsGranted(tenantId, {
        captions,
        images,
        videos,
      });
    }
    return granted;
  } catch (error) {
    logger.error({ err: error, tenantId }, "Signup credit grant failed");
    return false;
  }
}
