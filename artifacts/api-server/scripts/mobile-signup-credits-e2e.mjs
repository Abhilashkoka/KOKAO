#!/usr/bin/env node
/**
 * Mobile signup credit bundle e2e.
 *
 * Verifies that a BRAND-NEW user authenticating the way the Expo mobile app
 * does (Clerk bearer session token in the Authorization header — no browser
 * cookies) receives exactly one signup_bonus ledger row and the configured
 * balance during first-request tenant provisioning.
 *
 * Harness pattern (see .agents/memory/expo-e2e-testing.md):
 *   1. Clerk backend API (CLERK_SECRET_KEY): create user -> session -> token
 *   2. Hit the API with `Authorization: Bearer <jwt>` (same mechanism as the
 *      mobile client's setAuthTokenGetter)
 *   3. Assert against the DB, then clean up the Clerk user + DB rows.
 *
 * Temporarily flips signup_credit_settings.enabled=true (restores after).
 * Run:  node artifacts/api-server/scripts/mobile-signup-credits-e2e.mjs
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

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

let clerkUserId = null;
let settingsRestore = null;

try {
  // --- arrange: enable the bundle (remember prior state) -----------------
  const s = (
    await db.query(
      "select id, enabled, caption_credits, image_credits, video_credits from signup_credit_settings order by id limit 1",
    )
  ).rows[0];
  if (!s) throw new Error("no signup_credit_settings row; configure the bundle first");
  settingsRestore = s;
  await db.query("update signup_credit_settings set enabled=true where id=$1", [s.id]);
  const expected = {
    captions: Math.max(0, s.caption_credits),
    images: Math.max(0, s.image_credits),
    videos: Math.max(0, s.video_credits),
  };

  // --- arrange: brand-new Clerk user + bearer token (mobile auth path) ---
  const tag = randomBytes(4).toString("hex");
  const email = `mobile-signup-${tag}+clerk_test@example.com`;
  const user = await clerk("POST", "/users", {
    email_address: [email],
    password: `Tmp-${randomBytes(9).toString("base64url")}`,
    skip_password_checks: true,
  });
  clerkUserId = user.id;
  const session = await clerk("POST", "/sessions", { user_id: clerkUserId });
  const { jwt } = await clerk("POST", `/sessions/${session.id}/tokens`, {
    expires_in_seconds: 300,
  });

  // --- act: first authenticated request, bearer only (no cookies) --------
  const me = await fetch(`${API_BASE}/me`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  check("first bearer request succeeds (/me)", me.ok, `status ${me.status}`);

  const tenant = (
    await db.query("select id, signup_credits_granted_at from tenants where clerk_user_id=$1", [
      clerkUserId,
    ])
  ).rows[0];
  check("tenant provisioned for mobile user", Boolean(tenant));
  if (tenant) {
    check("signup_credits_granted_at stamped", Boolean(tenant.signup_credits_granted_at));

    const ledger = (
      await db.query(
        "select kind, caption_delta, image_delta, video_delta from credit_ledger where tenant_id=$1 and kind='signup_bonus'",
        [tenant.id],
      )
    ).rows;
    check("exactly one signup_bonus ledger row", ledger.length === 1, `got ${ledger.length}`);
    if (ledger[0])
      check(
        "ledger deltas match configured bundle",
        ledger[0].caption_delta === expected.captions &&
          ledger[0].image_delta === expected.images &&
          ledger[0].video_delta === expected.videos,
        JSON.stringify(ledger[0]),
      );

    const bal = (
      await db.query(
        "select caption_credits, image_credits, video_credits from credit_balances where tenant_id=$1",
        [tenant.id],
      )
    ).rows[0];
    check(
      "balance equals configured bundle",
      bal &&
        bal.caption_credits === expected.captions &&
        bal.image_credits === expected.images &&
        bal.video_credits === expected.videos,
      JSON.stringify(bal),
    );

    // --- act again: second request must not double-grant ------------------
    const me2 = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    check("second bearer request succeeds", me2.ok, `status ${me2.status}`);
    const count2 = (
      await db.query(
        "select count(*)::int as n from credit_ledger where tenant_id=$1 and kind='signup_bonus'",
        [tenant.id],
      )
    ).rows[0].n;
    check("still exactly one signup_bonus row after second request", count2 === 1, `got ${count2}`);
  }
} finally {
  // --- cleanup ------------------------------------------------------------
  if (settingsRestore)
    await db
      .query("update signup_credit_settings set enabled=$2 where id=$1", [
        settingsRestore.id,
        settingsRestore.enabled,
      ])
      .catch((e) => console.error("settings restore failed", e));
  if (clerkUserId) {
    const t = (
      await db.query("select id from tenants where clerk_user_id=$1", [clerkUserId])
    ).rows[0];
    if (t) {
      await db.query("delete from tenants where id=$1", [t.id]).catch(async () => {
        // FK-ordered fallback if tenants has no cascading deletes
        for (const tbl of ["credit_ledger", "credit_balances", "notifications"])
          await db.query(`delete from ${tbl} where tenant_id=$1`, [t.id]).catch(() => {});
        await db.query("delete from tenants where id=$1", [t.id]).catch((e) =>
          console.error("tenant cleanup failed", e),
        );
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
