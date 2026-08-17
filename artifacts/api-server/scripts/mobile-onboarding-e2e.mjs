#!/usr/bin/env node
/**
 * Mobile onboarding wizard e2e.
 *
 * Drives the same API sequence the Expo OnboardingWizard component executes
 * (consent, brand-kit draft, brand-kit create, generate-caption, save content,
 * complete onboarding) using the mobile auth path (Clerk bearer token, no
 * browser cookies).  Also verifies the skip path.
 *
 * Harness pattern (see .agents/memory/expo-e2e-testing.md):
 *   1. Clerk backend API (CLERK_SECRET_KEY): create user -> session -> token
 *   2. Hit the API with `Authorization: Bearer <jwt>` (same mechanism as the
 *      mobile client's setAuthTokenGetter)
 *   3. Assert DB state, then clean up Clerk user + DB rows.
 *
 * Run:  node artifacts/api-server/scripts/mobile-onboarding-e2e.mjs
 */
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const API_BASE = process.env.API_BASE ?? "http://localhost:80/api";
const CLERK_API = "https://api.clerk.com/v1";
const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) throw new Error("CLERK_SECRET_KEY required");

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function api(jwt, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, json };
}

/** Create a fresh Clerk user and return { clerkUserId, jwt }. */
async function createMobileUser(tag) {
  const email = `mobile-onboarding-${tag}+clerk_test@example.com`;
  const user = await clerk("POST", "/users", {
    email_address: [email],
    password: `Tmp-${randomBytes(9).toString("base64url")}`,
    skip_password_checks: true,
  });
  const session = await clerk("POST", "/sessions", { user_id: user.id });
  const { jwt } = await clerk("POST", `/sessions/${session.id}/tokens`, {
    expires_in_seconds: 300,
  });
  return { clerkUserId: user.id, email, jwt };
}

/** Clean up a test tenant and its Clerk user. Best-effort, logs on failure. */
async function cleanup(clerkUserId) {
  if (!clerkUserId) return;
  const row = (
    await db
      .query("select id from tenants where clerk_user_id=$1", [clerkUserId])
      .catch(() => ({ rows: [] }))
  ).rows[0];
  if (row) {
    const tid = row.id;
    // FK-ordered deletion (mirrors dbHelpers.deleteTenant)
    for (const tbl of [
      "analytics_events",
      "user_consents",
      "content_items",
      "brand_kits",
      "credit_ledger",
      "credit_balances",
      "notifications",
    ]) {
      await db
        .query(`delete from ${tbl} where tenant_id=$1`, [tid])
        .catch(() => {});
    }
    await db
      .query("delete from tenants where id=$1", [tid])
      .catch((e) => console.error("  tenant cleanup failed:", e.message));
  }
  await clerk("DELETE", `/users/${clerkUserId}`).catch((e) =>
    console.error("  clerk user cleanup failed:", e.message),
  );
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// Flow 1: Complete onboarding
// ---------------------------------------------------------------------------

let completeUser = null;
console.log("\n── Flow 1: complete onboarding ──────────────────────────────────");
try {
  const tag = randomBytes(4).toString("hex");
  completeUser = await createMobileUser(tag);
  const { clerkUserId, jwt } = completeUser;

  // Provision the tenant with the first bearer request (same as mobile app)
  const meRes = await api(jwt, "GET", "/me");
  check("first bearer /me succeeds", meRes.ok, `status ${meRes.status}`);
  check(
    "brandOnboardingComplete starts false",
    meRes.json?.brandOnboardingComplete === false,
    String(meRes.json?.brandOnboardingComplete),
  );

  // Consent (wizard step 1): PUT /consent — all flags off by default, just respond
  const consentRes = await api(jwt, "PUT", "/consent", {
    analytics: true,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
  });
  check("PUT /consent succeeds", consentRes.ok, `status ${consentRes.status}`);
  check(
    "consent responded flag set",
    consentRes.json?.responded === true,
    String(consentRes.json?.responded),
  );

  // Fetch tenant id for DB assertions
  const tenant = (
    await db.query("select id from tenants where clerk_user_id=$1", [clerkUserId])
  ).rows[0];
  check("tenant provisioned", Boolean(tenant));
  const tenantId = tenant?.id;

  // Brand Kit draft (may fail if AI not configured — gracefully handled by wizard)
  let payload = null;
  const draftRes = await api(jwt, "POST", "/brand-kits/draft", {
    brandName: "E2E Coffee Co",
    notes: [
      "What the business does: We roast small-batch coffee and ship across India.",
      "Target audience: Young professionals who love specialty coffee.",
      "Preferred tone of voice: Friendly",
    ].join("\n"),
  });
  if (draftRes.ok && draftRes.json?.payload) {
    payload = draftRes.json.payload;
    console.log("INFO: brand-kit draft succeeded (AI available)");
  } else {
    console.log(
      `INFO: brand-kit draft skipped/failed (${draftRes.status}) — using blank kit (matches wizard fallback)`,
    );
  }

  // Brand Kit create — must always succeed
  const kitRes = await api(jwt, "POST", "/brand-kits", {
    name: "E2E Coffee Co",
    brandType: "primary",
    isDefault: true,
    payload,
  });
  check("POST /brand-kits succeeds", kitRes.ok, `status ${kitRes.status}`);
  const brandKitId = kitRes.json?.id;
  check("brand kit id returned", typeof brandKitId === "number", String(brandKitId));

  // DB: brand kit row exists
  if (tenantId) {
    const kit = (
      await db.query(
        "select id, name, is_default from brand_kits where tenant_id=$1 and name='E2E Coffee Co'",
        [tenantId],
      )
    ).rows[0];
    check("brand_kits row exists in DB", Boolean(kit));
    check("brand kit marked default", kit?.is_default === true, String(kit?.is_default));
  }

  // Caption generate (may 402 if no credits — wizard degrades gracefully to studio route)
  let captionText = null;
  const captionRes = await api(jwt, "POST", "/ai/generate-caption", {
    prompt:
      "An introduction post for E2E Coffee Co. " +
      "About the business: We roast small-batch coffee and ship across India. " +
      "The audience: Young professionals who love specialty coffee. " +
      "Introduce the brand and invite people to follow for more.",
    platform: "instagram",
    tone: "Friendly",
    brandKitId,
  });
  if (captionRes.ok && captionRes.json?.caption) {
    captionText = captionRes.json.caption;
    console.log("INFO: caption generation succeeded");

    // Save content
    const contentRes = await api(jwt, "POST", "/content", {
      title: "E2E Coffee Co — introduction post",
      caption: captionText,
      platform: "instagram",
      status: "draft",
      brandKitId,
    });
    check("POST /content succeeds", contentRes.ok, `status ${contentRes.status}`);
    check("content id returned", typeof contentRes.json?.id === "number");

    // DB: content_items row
    if (tenantId) {
      const content = (
        await db.query(
          "select id from content_items where tenant_id=$1 and brand_kit_id=$2 and status='draft'",
          [tenantId, brandKitId],
        )
      ).rows[0];
      check("content_items row exists in DB", Boolean(content));
    }
  } else {
    console.log(
      `INFO: caption generation returned ${captionRes.status} — verifying graceful-degradation path (no content row expected)`,
    );
    if (tenantId) {
      const content = (
        await db.query("select id from content_items where tenant_id=$1", [tenantId])
      ).rows[0];
      check(
        "no content_items row on caption failure (wizard skips content save)",
        !content,
        content ? `found row id=${content.id}` : "none",
      );
    }
  }

  // Analytics events: send onboarding events (mirrors what the wizard tracks)
  const analyticsRes = await api(jwt, "POST", "/analytics/events", {
    events: [
      { name: "onboarding_started", params: { entry_point: "first_login" } },
      { name: "onboarding_interview_completed" },
      { name: "onboarding_brand_kit_created", params: { ai_drafted: payload !== null } },
      { name: "onboarding_completed", params: { completion_time_sec: 42 } },
    ],
  });
  check(
    "POST /analytics/events accepted >=1 event",
    analyticsRes.ok && (analyticsRes.json?.accepted ?? 0) >= 1,
    JSON.stringify(analyticsRes.json),
  );

  // DB: analytics events stored
  if (tenantId) {
    const evts = (
      await db.query(
        "select event_name from analytics_events where tenant_id=$1 order by created_at",
        [tenantId],
      )
    ).rows.map((r) => r.event_name);
    check(
      "onboarding_started event in DB",
      evts.includes("onboarding_started"),
      JSON.stringify(evts),
    );
    check(
      "onboarding_completed event in DB",
      evts.includes("onboarding_completed"),
      JSON.stringify(evts),
    );
  }

  // Complete onboarding (wizard finish())
  const completeRes = await api(jwt, "POST", "/onboarding/complete", { skipped: false });
  check("POST /onboarding/complete succeeds", completeRes.ok, `status ${completeRes.status}`);
  check(
    "complete response has complete:true",
    completeRes.json?.complete === true,
    String(completeRes.json?.complete),
  );

  // DB: onboarding flag flipped
  if (tenantId) {
    const t = (
      await db.query(
        "select brand_onboarding_complete from tenants where id=$1",
        [tenantId],
      )
    ).rows[0];
    check(
      "brandOnboardingComplete = true in DB",
      t?.brand_onboarding_complete === true,
      String(t?.brand_onboarding_complete),
    );
  }

  // /me now reflects completed onboarding
  const me2 = await api(jwt, "GET", "/me");
  check(
    "GET /me shows brandOnboardingComplete=true after completion",
    me2.json?.brandOnboardingComplete === true,
    String(me2.json?.brandOnboardingComplete),
  );
} finally {
  await cleanup(completeUser?.clerkUserId);
}

// ---------------------------------------------------------------------------
// Flow 2: Skip onboarding
// ---------------------------------------------------------------------------

let skipUser = null;
console.log("\n── Flow 2: skip onboarding ──────────────────────────────────────");
try {
  const tag = randomBytes(4).toString("hex");
  skipUser = await createMobileUser(tag);
  const { clerkUserId, jwt } = skipUser;

  // Provision tenant
  const meRes = await api(jwt, "GET", "/me");
  check("skip flow: /me succeeds", meRes.ok, `status ${meRes.status}`);
  check(
    "skip flow: onboarding starts incomplete",
    meRes.json?.brandOnboardingComplete === false,
  );

  const tenant = (
    await db.query("select id from tenants where clerk_user_id=$1", [clerkUserId])
  ).rows[0];
  const tenantId = tenant?.id;

  // Consent respond (user hit Continue with defaults)
  const consentRes = await api(jwt, "PUT", "/consent", {
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
  });
  check("skip flow: PUT /consent succeeds", consentRes.ok, `status ${consentRes.status}`);

  // Analytics: send skip event (wizard emits this before calling finish(true))
  // Note: analytics consent is off here so the server will drop the event (accepted=0).
  // That matches production — the wizard calls track() which respects consent locally,
  // but the server-side ingest gate is separate. We still verify the endpoint returns 200.
  const skipEvtRes = await api(jwt, "POST", "/analytics/events", {
    events: [{ name: "onboarding_skipped", params: { stage: "welcome" } }],
  });
  check(
    "skip flow: POST /analytics/events returns 200",
    skipEvtRes.ok,
    `status ${skipEvtRes.status}`,
  );

  // Complete onboarding with skipped:true (wizard's finish(true))
  const completeRes = await api(jwt, "POST", "/onboarding/complete", { skipped: true });
  check(
    "skip flow: POST /onboarding/complete succeeds",
    completeRes.ok,
    `status ${completeRes.status}`,
  );
  check(
    "skip flow: complete:true returned",
    completeRes.json?.complete === true,
    String(completeRes.json?.complete),
  );

  // DB: flag set even on skip
  if (tenantId) {
    const t = (
      await db.query(
        "select brand_onboarding_complete from tenants where id=$1",
        [tenantId],
      )
    ).rows[0];
    check(
      "skip flow: brandOnboardingComplete = true in DB",
      t?.brand_onboarding_complete === true,
      String(t?.brand_onboarding_complete),
    );

    // No brand_kits or content_items should exist for a skipped user
    const kitCount = (
      await db.query("select count(*)::int as n from brand_kits where tenant_id=$1", [tenantId])
    ).rows[0].n;
    check("skip flow: no brand_kits rows created", kitCount === 0, `got ${kitCount}`);

    const contentCount = (
      await db.query(
        "select count(*)::int as n from content_items where tenant_id=$1",
        [tenantId],
      )
    ).rows[0].n;
    check(
      "skip flow: no content_items rows created",
      contentCount === 0,
      `got ${contentCount}`,
    );
  }

  // /me reflects completed onboarding even after skip
  const me2 = await api(jwt, "GET", "/me");
  check(
    "skip flow: GET /me shows brandOnboardingComplete=true",
    me2.json?.brandOnboardingComplete === true,
    String(me2.json?.brandOnboardingComplete),
  );
} finally {
  await cleanup(skipUser?.clerkUserId);
}

// ---------------------------------------------------------------------------
// Flow 3: Brand-kit plan cap (POST /brand-kits → 402)
// The wizard must call completeOnboarding and flip the flag even when kit
// creation is blocked, so the user is never trapped in an infinite loop.
// ---------------------------------------------------------------------------

let cappedUser = null;
console.log("\n── Flow 3: plan-cap blocks brand-kit creation ───────────────────");
try {
  const tag = randomBytes(4).toString("hex");
  cappedUser = await createMobileUser(tag);
  const { clerkUserId, jwt } = cappedUser;

  // Provision the tenant.
  const meRes = await api(jwt, "GET", "/me");
  check("cap flow: /me succeeds", meRes.ok, `status ${meRes.status}`);
  check(
    "cap flow: onboarding starts incomplete",
    meRes.json?.brandOnboardingComplete === false,
  );

  const tenant = (
    await db.query("select id from tenants where clerk_user_id=$1", [clerkUserId])
  ).rows[0];
  check("cap flow: tenant provisioned", Boolean(tenant));
  const tenantId = tenant?.id;

  // Consent step.
  const consentRes = await api(jwt, "PUT", "/consent", {
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
  });
  check("cap flow: PUT /consent succeeds", consentRes.ok, `status ${consentRes.status}`);

  // Exhaust the free plan's brand-kit allowance (limit = 1) by inserting a
  // pre-existing kit directly.  The wizard will then see 402 on POST /brand-kits.
  if (tenantId) {
    await db.query(
      `insert into brand_kits
         (tenant_id, name, slug, brand_type, status, is_default, is_archived, created_by)
       values ($1, 'Pre-existing Kit', 'pre-existing-kit', 'primary', 'draft', true, false, $2)`,
      [tenantId, clerkUserId],
    );
    const kitCount = (
      await db.query(
        "select count(*)::int as n from brand_kits where tenant_id=$1 and is_archived=false",
        [tenantId],
      )
    ).rows[0].n;
    check("cap flow: cap kit seeded (count=1)", kitCount === 1, `got ${kitCount}`);
  }

  // POST /brand-kits must now return 402.
  const kitRes = await api(jwt, "POST", "/brand-kits", {
    name: "New Brand",
    brandType: "primary",
    isDefault: false,
    payload: null,
  });
  check(
    "cap flow: POST /brand-kits returns 402",
    kitRes.status === 402,
    `got ${kitRes.status}`,
  );

  // The wizard's catch block calls finish(false) without saving a caption.
  // Simulate that: call completeOnboarding directly.
  const completeRes = await api(jwt, "POST", "/onboarding/complete", { skipped: false });
  check(
    "cap flow: POST /onboarding/complete succeeds",
    completeRes.ok,
    `status ${completeRes.status}`,
  );
  check(
    "cap flow: complete:true returned",
    completeRes.json?.complete === true,
    String(completeRes.json?.complete),
  );

  // DB: flag flipped.
  if (tenantId) {
    const t = (
      await db.query(
        "select brand_onboarding_complete from tenants where id=$1",
        [tenantId],
      )
    ).rows[0];
    check(
      "cap flow: brandOnboardingComplete = true in DB",
      t?.brand_onboarding_complete === true,
      String(t?.brand_onboarding_complete),
    );

    // Only the seeded pre-existing kit — no extra kit from the wizard.
    const kitCount = (
      await db.query(
        "select count(*)::int as n from brand_kits where tenant_id=$1",
        [tenantId],
      )
    ).rows[0].n;
    check(
      "cap flow: no extra brand_kits row created by wizard",
      kitCount === 1,
      `got ${kitCount}`,
    );

    // No content_items: wizard skips caption step when brand-kit creation fails.
    const contentCount = (
      await db.query(
        "select count(*)::int as n from content_items where tenant_id=$1",
        [tenantId],
      )
    ).rows[0].n;
    check(
      "cap flow: no content_items row created",
      contentCount === 0,
      `got ${contentCount}`,
    );
  }

  // /me shows the wizard is done — it must not loop on the next launch.
  const me2 = await api(jwt, "GET", "/me");
  check(
    "cap flow: GET /me shows brandOnboardingComplete=true (wizard won't loop)",
    me2.json?.brandOnboardingComplete === true,
    String(me2.json?.brandOnboardingComplete),
  );
} finally {
  await cleanup(cappedUser?.clerkUserId);
  await db.end();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
