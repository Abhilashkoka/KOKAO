import {
  db,
  bytePlusIdentitiesTable,
  charactersTable,
  type BytePlusIdentity,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { signOAuthState, verifySignedOAuthState } from "./oauthState";
import {
  BYTEPLUS_TOKEN_TTL_MS,
  BYTEPLUS_VERIFY_SUCCESS_CODE,
  createLivenessVerification,
  deleteAssetGroup,
  resolveBytePlusAssetsCredentials,
  resolveLivenessAssetGroup,
} from "./byteplus/assets";
import { logger } from "./logger";

export function signBytePlusIdentityState(
  tenantId: number,
  identityId: number,
  returnTarget: "web" | "mobile" = "web",
): string {
  return signOAuthState(tenantId, `${identityId}:${returnTarget}`);
}

function tokenHash(token: string): string {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required for identity verification");
  return createHmac("sha256", process.env.SESSION_SECRET).update(token).digest("hex");
}

function hashesEqual(left: string | null, token: string | undefined): boolean {
  if (!left || !token) return false;
  const actual = Buffer.from(left, "hex");
  const expected = Buffer.from(tokenHash(token), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyBytePlusIdentityState(
  state: string,
): { tenantId: number; identityId: number; returnTarget: "web" | "mobile" } | null {
  const verified = verifySignedOAuthState(state, BYTEPLUS_TOKEN_TTL_MS);
  if (!verified) return null;
  const [rawIdentityId, rawReturnTarget = "web"] = verified.data.split(":");
  const identityId = Number(rawIdentityId);
  const returnTarget = rawReturnTarget === "mobile" ? "mobile" : "web";
  return Number.isInteger(identityId) && identityId > 0
    ? { tenantId: verified.tenantId, identityId, returnTarget }
    : null;
}

export async function startBytePlusIdentityVerification(args: {
  tenantId: number;
  label: string;
  callbackBaseUrl: string;
  returnTarget?: "web" | "mobile";
}): Promise<{ identity: BytePlusIdentity; verificationUrl: string }> {
  const credentials = await resolveBytePlusAssetsCredentials();
  if (!credentials) throw new Error("BytePlus Asset Library is not configured.");
  const [identity] = await db.insert(bytePlusIdentitiesTable).values({
    tenantId: args.tenantId,
    label: args.label,
  }).returning();
  try {
    const state = signBytePlusIdentityState(
      args.tenantId,
      identity!.id,
      args.returnTarget ?? "web",
    );
    const session = await createLivenessVerification(
      `${args.callbackBaseUrl}/${encodeURIComponent(state)}`,
      credentials,
    );
    await db.update(bytePlusIdentitiesTable).set({
      verificationTokenHash: tokenHash(session.bytedToken),
    }).where(and(eq(bytePlusIdentitiesTable.id, identity!.id), eq(bytePlusIdentitiesTable.status, "pending")));
    return { identity: identity!, verificationUrl: session.verificationUrl };
  } catch (error) {
    await db.update(bytePlusIdentitiesTable).set({
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 500) : "Verification could not start.",
    }).where(eq(bytePlusIdentitiesTable.id, identity!.id)).catch(() => {});
    throw error;
  }
}

export async function completeBytePlusIdentityVerification(args: {
  state: string;
  bytedToken?: string;
  resultCode?: string;
}): Promise<{
  ok: boolean;
  identityId: number | null;
  reason: string | null;
  returnTarget?: "web" | "mobile";
}> {
  const state = verifyBytePlusIdentityState(args.state);
  if (!state) return { ok: false, identityId: null, reason: "invalid_state" };
  const [identity] = await db.select().from(bytePlusIdentitiesTable).where(and(
    eq(bytePlusIdentitiesTable.id, state.identityId),
    eq(bytePlusIdentitiesTable.tenantId, state.tenantId),
  )).limit(1);
  if (!identity) return { ok: false, identityId: null, reason: "unknown_identity", returnTarget: state.returnTarget };
  if (!hashesEqual(identity.verificationTokenHash, args.bytedToken)) {
    return { ok: false, identityId: identity.id, reason: "token_mismatch", returnTarget: state.returnTarget };
  }
  if (identity.status === "verified" && identity.assetGroupId) {
    return { ok: true, identityId: identity.id, reason: null, returnTarget: state.returnTarget };
  }
  // Claim completion before trusting the result code or contacting BytePlus.
  // This makes a callback token single-use even when callbacks race.
  const [claimed] = await db.update(bytePlusIdentitiesTable).set({ status: "completing" }).where(and(
    eq(bytePlusIdentitiesTable.id, identity.id),
    eq(bytePlusIdentitiesTable.tenantId, state.tenantId),
    eq(bytePlusIdentitiesTable.status, "pending"),
    eq(bytePlusIdentitiesTable.verificationTokenHash, identity.verificationTokenHash!),
  )).returning({ id: bytePlusIdentitiesTable.id });
  if (!claimed) return { ok: false, identityId: identity.id, reason: "already_completed", returnTarget: state.returnTarget };
  const fail = async (reason: string, error: string) => {
    await db.update(bytePlusIdentitiesTable).set({
      status: "failed", resultCode: args.resultCode ?? null, error,
    }).where(and(eq(bytePlusIdentitiesTable.id, identity.id), eq(bytePlusIdentitiesTable.status, "completing"))).catch(() => {});
    return { ok: false, identityId: identity.id, reason, returnTarget: state.returnTarget };
  };
  if (args.resultCode !== BYTEPLUS_VERIFY_SUCCESS_CODE) {
    return fail("verification_failed", "BytePlus did not confirm this identity.");
  }
  if (!args.bytedToken) return fail("missing_token", "The verification callback had no token.");
  const credentials = await resolveBytePlusAssetsCredentials();
  if (!credentials) return fail("not_configured", "BytePlus Asset Library is not configured.");
  try {
    const assetGroupId = await resolveLivenessAssetGroup(args.bytedToken, credentials);
    const [finalized] = await db
      .update(bytePlusIdentitiesTable)
      .set({
        assetGroupId,
        status: "verified",
        resultCode: args.resultCode,
        error: null,
        verifiedAt: new Date(),
      })
      .where(
        and(
          eq(bytePlusIdentitiesTable.id, identity.id),
          eq(bytePlusIdentitiesTable.tenantId, state.tenantId),
          eq(bytePlusIdentitiesTable.status, "completing"),
        ),
      )
      .returning({ id: bytePlusIdentitiesTable.id });
    if (!finalized) {
      await deleteAssetGroup(assetGroupId, credentials).catch((error) =>
        logger.warn(
          { err: error, assetGroupId },
          "BytePlus identity was removed during verification; compensating asset cleanup failed",
        ),
      );
      return {
        ok: false,
        identityId: identity.id,
        reason: "identity_deleted",
        returnTarget: state.returnTarget,
      };
    }
    return { ok: true, identityId: identity.id, reason: null, returnTarget: state.returnTarget };
  } catch (error) {
    return fail(
      "group_lookup_failed",
      error instanceof Error ? error.message.slice(0, 500) : "Asset group lookup failed.",
    );
  }
}

export function listBytePlusIdentities(tenantId: number): Promise<BytePlusIdentity[]> {
  return db.select().from(bytePlusIdentitiesTable)
    .where(eq(bytePlusIdentitiesTable.tenantId, tenantId))
    .orderBy(asc(bytePlusIdentitiesTable.id));
}

export async function getBytePlusIdentity(
  tenantId: number,
  id: number,
): Promise<BytePlusIdentity | undefined> {
  const [identity] = await db.select().from(bytePlusIdentitiesTable).where(and(
    eq(bytePlusIdentitiesTable.id, id),
    eq(bytePlusIdentitiesTable.tenantId, tenantId),
  )).limit(1);
  return identity;
}

export type DeleteBytePlusIdentityResult =
  | { outcome: "deleted"; assetGroupId: string | null }
  | { outcome: "not_found" }
  | { outcome: "attached"; characterNames: string[] };

export async function deleteBytePlusIdentity(
  tenantId: number,
  id: number,
): Promise<DeleteBytePlusIdentityResult> {
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select()
      .from(bytePlusIdentitiesTable)
      .where(
        and(
          eq(bytePlusIdentitiesTable.id, id),
          eq(bytePlusIdentitiesTable.tenantId, tenantId),
        ),
      )
      .for("update")
      .limit(1);
    if (!identity) return { outcome: "not_found" };

    const attached = await tx
      .select({ name: charactersTable.name })
      .from(charactersTable)
      .where(
        and(
          eq(charactersTable.tenantId, tenantId),
          eq(charactersTable.bytePlusIdentityId, id),
        ),
      );
    if (attached.length) {
      return {
        outcome: "attached",
        characterNames: attached.map((character) => character.name),
      };
    }

    await tx
      .delete(bytePlusIdentitiesTable)
      .where(
        and(
          eq(bytePlusIdentitiesTable.id, id),
          eq(bytePlusIdentitiesTable.tenantId, tenantId),
        ),
      );
    return { outcome: "deleted", assetGroupId: identity.assetGroupId };
  });
}

export function deleteBytePlusIdentityAssetsInBackground(assetGroupId: string | null): void {
  if (!assetGroupId) return;
  void (async () => {
    try {
      const credentials = await resolveBytePlusAssetsCredentials();
      if (!credentials) return;
      await deleteAssetGroup(assetGroupId, credentials);
    } catch (error) {
      logger.warn(
        { err: error, assetGroupId },
        "BytePlus identity asset-group cleanup failed",
      );
    }
  })();
}