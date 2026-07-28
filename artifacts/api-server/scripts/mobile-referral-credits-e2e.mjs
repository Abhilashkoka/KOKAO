#!/usr/bin/env node
/**
 * Mobile referral (invite-code) credits e2e.
 *
 * Verifies the referral grant path over the MOBILE auth mechanism (Clerk
 * bearer session token in the Authorization header — no browser cookies):
 *   - a referrer signing in via bearer can mint their personal invite code
 *     (GET /gamification/referral — the same endpoint the app uses),
 *   - a brand-new referee signing up via bearer can redeem it
 *     (POST /billing/promo/redeem — used by the mobile Settings redeem UI),
 *   - the referee gets the referee bonus and the referrer earns the
 *     referrer reward, each exactly once,
 *   - a second redemption attempt is rejected and grants nothing.
 *
 * Harness pattern from artifacts/api-server/scripts/mobile-signup-credits-e2e.mjs
 * (see .agents/memory/expo-e2e-testing.md):
 *   Clerk backend API -> user -> session -> token; bearer requests; DB asserts;
 *   full cleanup (both Clerk users, both tenants, minted promo code).
 *
 * Temporarily forces the 'referrals' feature flag on (restores after).
 * Run:  node artifacts/api-server/scripts/mobile-referral-credits-e2e.mjs
 */
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const API_BASE = process.env.API_BASE ?? "http://localhost:80/api";
const CLERK_API = "https://api.clerk.com/v1";
const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) throw new Error("CLERK_SECRET_KEY required");

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function clerk(method, path, body) {
  const res = await fetch(`${CLERK_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`Clerk ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Create a Clerk user + short-lived bearer token (the mobile auth path). */
async function makeBearerUser(label) {
  const tag = randomBytes(4).toString("hex");
  const email = `mobile-ref-${label}-${tag}+clerk_test@example.com`;
  const user = await clerk("POST", "/users", {
    email_address: [email],
    password: `Tmp-${randomBytes(9).toString("base64url")}`,
    skip_password_checks: true,
  });
  const session = await clerk("POST", "/sessions", { user_id: user.id });
  const { jwt } = await clerk("POST", `/sessions/${session.id}/tokens`, {
    expires_in_seconds: 600,
  });
  return { clerkUserId: user.id, email, jwt };
}

const api = (jwt) => (method, path, body) =>
  fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const clerkUserIds = [];
let flagRestore; // undefined = untouched, null = no row existed, row = prior state

try {
  // --- arrange: force the referrals kill switch ON (remember prior state) --
  const flagRow = (
    await db.query("select feature, enabled from feature_flags where feature='referrals'")
  ).rows[0];
  flagRestore = flagRow ?? null;
  await db.query(
    `insert into feature_flags (feature, enabled) values ('referrals', true)
     on conflict (feature) do update set enabled=true, updated_at=now()`,
  );

  // --- referrer: bearer sign-in, provision, mint invite code --------------
  const referrer = await makeBearerUser("referrer");
  clerkUserIds.push(referrer.clerkUserId);
  const refApi = api(referrer.jwt);
  const meA = await refApi("GET", "/me");
  check("referrer bearer /me succeeds", meA.ok, `status ${meA.status}`);
  const refTenant = (
    await db.query("select id, plan from tenants where clerk_user_id=$1", [
      referrer.clerkUserId,
    ])
  ).rows[0];
  check("referrer tenant provisioned", Boolean(refTenant));

  const refInfoRes = await refApi("GET", "/gamification/referral");
  check(
    "referrer can mint invite code over bearer",
    refInfoRes.ok,
    `status ${refInfoRes.status}`,
  );
  const refInfo = refInfoRes.ok ? await refInfoRes.json() : null;
  check("invite code returned", Boolean(refInfo?.code), refInfo?.code ?? "none");
  if (!refInfo?.code) throw new Error("no invite code; aborting");

  const refBalanceBefore = (
    await db.query(
      "select caption_credits, image_credits from credit_balances where tenant_id=$1",
      [refTenant.id],
    )
  ).rows[0] ?? { caption_credits: 0, image_credits: 0 };

  // --- referee: brand-new bearer signup, redeem the code ------------------
  const referee = await makeBearerUser("referee");
  clerkUserIds.push(referee.clerkUserId);
  const eeApi = api(referee.jwt);
  const meB = await eeApi("GET", "/me");
  check("referee bearer /me succeeds (provisioning)", meB.ok, `status ${meB.status}`);
  const eeTenant = (
    await db.query("select id from tenants where clerk_user_id=$1", [referee.clerkUserId])
  ).rows[0];
  check("referee tenant provisioned", Boolean(eeTenant));
  if (!eeTenant) throw new Error("no referee tenant; aborting");

  const eeBalanceBefore = (
    await db.query(
      "select caption_credits, image_credits from credit_balances where tenant_id=$1",
      [eeTenant.id],
    )
  ).rows[0] ?? { caption_credits: 0, image_credits: 0 };

  const redeemRes = await eeApi("POST", "/billing/promo/redeem", {
    code: refInfo.code,
  });
  const redeemJson = await redeemRes.json().catch(() => ({}));
  check(
    "redeem over bearer succeeds",
    redeemRes.ok && redeemJson.ok === true,
    `status ${redeemRes.status}: ${JSON.stringify(redeemJson)}`,
  );

  // --- assert: referee bonus, exactly once ---------------------------------
  const promoLedger = (
    await db.query(
      "select caption_delta, image_delta from credit_ledger where tenant_id=$1 and kind='promo'",
      [eeTenant.id],
    )
  ).rows;
  check("exactly one promo ledger row for referee", promoLedger.length === 1, `got ${promoLedger.length}`);
  if (promoLedger[0])
    check(
      "referee deltas match the code's referee amounts",
      promoLedger[0].caption_delta === refInfo.refereeCaptionCredits &&
        promoLedger[0].image_delta === refInfo.refereeImageCredits,
      JSON.stringify(promoLedger[0]),
    );
  const eeBalanceAfter = (
    await db.query(
      "select caption_credits, image_credits from credit_balances where tenant_id=$1",
      [eeTenant.id],
    )
  ).rows[0];
  check(
    "referee balance increased by referee bonus",
    eeBalanceAfter &&
      eeBalanceAfter.caption_credits ===
        eeBalanceBefore.caption_credits + refInfo.refereeCaptionCredits &&
      eeBalanceAfter.image_credits ===
        eeBalanceBefore.image_credits + refInfo.refereeImageCredits,
    JSON.stringify(eeBalanceAfter),
  );

  // --- assert: referrer reward, exactly once --------------------------------
  const rewardLedger = (
    await db.query(
      "select caption_delta, image_delta from credit_ledger where tenant_id=$1 and kind='referral_reward'",
      [refTenant.id],
    )
  ).rows;
  check(
    "exactly one referral_reward ledger row for referrer",
    rewardLedger.length === 1,
    `got ${rewardLedger.length}`,
  );
  if (rewardLedger[0])
    check(
      "referrer deltas match plan referrer amounts",
      rewardLedger[0].caption_delta === refInfo.referrerCaptionCredits &&
        rewardLedger[0].image_delta === refInfo.referrerImageCredits,
      JSON.stringify(rewardLedger[0]),
    );
  const refBalanceAfter = (
    await db.query(
      "select caption_credits, image_credits from credit_balances where tenant_id=$1",
      [refTenant.id],
    )
  ).rows[0];
  check(
    "referrer balance increased by referrer reward",
    refBalanceAfter &&
      refBalanceAfter.caption_credits ===
        refBalanceBefore.caption_credits + refInfo.referrerCaptionCredits &&
      refBalanceAfter.image_credits ===
        refBalanceBefore.image_credits + refInfo.referrerImageCredits,
    JSON.stringify(refBalanceAfter),
  );

  // --- act again: second redemption must be rejected, no double grant ------
  const redeem2 = await eeApi("POST", "/billing/promo/redeem", { code: refInfo.code });
  const redeem2Json = await redeem2.json().catch(() => ({}));
  check(
    "second redemption rejected",
    redeem2.status === 400,
    `status ${redeem2.status}: ${JSON.stringify(redeem2Json)}`,
  );
  const counts = (
    await db.query(
      `select
         (select count(*)::int from credit_ledger where tenant_id=$1 and kind='promo') as promo,
         (select count(*)::int from credit_ledger where tenant_id=$2 and kind='referral_reward') as reward`,
      [eeTenant.id, refTenant.id],
    )
  ).rows[0];
  check("still exactly one promo row", counts.promo === 1, `got ${counts.promo}`);
  check("still exactly one reward row", counts.reward === 1, `got ${counts.reward}`);
} finally {
  // --- cleanup --------------------------------------------------------------
  if (flagRestore !== undefined) {
    if (flagRestore === null)
      await db
        .query("delete from feature_flags where feature='referrals'")
        .catch((e) => console.error("flag restore failed", e));
    else
      await db
        .query("update feature_flags set enabled=$1 where feature='referrals'", [
          flagRestore.enabled,
        ])
        .catch((e) => console.error("flag restore failed", e));
  }
  for (const clerkUserId of clerkUserIds) {
    const t = (
      await db.query("select id from tenants where clerk_user_id=$1", [clerkUserId])
    ).rows[0];
    if (t) {
      // The referrer's minted code and its redemptions must go before tenants.
      const codes = (
        await db.query("select id from promo_codes where owner_tenant_id=$1", [t.id])
      ).rows;
      for (const code of codes) {
        await db
          .query("delete from promo_redemptions where promo_code_id=$1", [code.id])
          .catch(() => {});
        await db.query("delete from promo_codes where id=$1", [code.id]).catch(() => {});
      }
      await db.query("delete from tenants where id=$1", [t.id]).catch(async () => {
        for (const tbl of [
          "promo_redemptions",
          "promo_redemption_failures",
          "credit_ledger",
          "credit_balances",
          "notifications",
        ])
          await db.query(`delete from ${tbl} where tenant_id=$1`, [t.id]).catch(() => {});
        await db
          .query("delete from tenants where id=$1", [t.id])
          .catch((e) => console.error("tenant cleanup failed", e));
      });
    }
    await clerk("DELETE", `/users/${clerkUserId}`).catch((e) =>
      console.error("clerk user cleanup failed", e),
    );
  }
  await db.end();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
