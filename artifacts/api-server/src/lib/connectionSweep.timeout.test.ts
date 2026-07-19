import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Override the sweep's per-check cap BEFORE the module under test is imported
// (it reads the env once at module load). vi.hoisted runs ahead of the
// hoisted ESM imports; a plain top-level assignment would run too late.
vi.hoisted(() => {
  process.env.SWEEP_CHECK_TIMEOUT_MS = "200";
});

// Hang the Facebook reverifier forever; keep LinkedIn fast and successful so
// we can prove the sweep moves past the hung check.
vi.mock("./socialReverify", () => ({
  // connectionSweep -> adsReverify imports this constant from socialReverify,
  // so the full-module mock must export it too.
  REVERIFY_STALE_MS: 15 * 60 * 1000,
  reverifyFacebook: vi.fn(
    () =>
      new Promise(() => {
        /* never resolves */
      }),
  ),
  reverifyInstagram: vi.fn(async () => null),
  reverifyLinkedin: vi.fn(async () => null),
  reverifyTwitter: vi.fn(async () => null),
  reverifyThreads: vi.fn(async () => null),
  reverifyYoutube: vi.fn(async () => null),
}));

// The sweep also covers ad-account connections; leftover rows from other
// tests in the shared dev DB would otherwise hit the real Meta Ads API and
// time out under the tiny cap, overwriting lastError with a meta_ads entry.
vi.mock("./adsReverify", () => ({
  reverifyMetaAds: vi.fn(async () => null),
}));

import { pool } from "@workspace/db";
import { sweepDeadConnections, SWEEP_CHECK_TIMEOUT_MS } from "./connectionSweep";
import { reverifyLinkedin } from "./socialReverify";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
} from "../test/dbHelpers";

let tenantId: number;

beforeAll(async () => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
  tenantId = (await createTenant()).tenantId;
  await insertConnectedAccount(tenantId, "facebook", { t: "x" }, "verified");
  await insertConnectedAccount(tenantId, "linkedin", { t: "x" }, "verified");
});

afterAll(async () => {
  await deleteTenant(tenantId);
  await pool.end();
});

describe("sweep per-check timeout", () => {
  it("honors the env override for the cap", () => {
    expect(SWEEP_CHECK_TIMEOUT_MS).toBe(200);
  });

  it("abandons a hung re-verify, records the error, and keeps sweeping", async () => {
    const outcome = await sweepDeadConnections();
    // Facebook hung and was abandoned after the cap. The sweep runs across
    // the whole shared dev DB, so other tenants' leftover rows may add to the
    // counts — assert on this tenant's behavior, not exact totals.
    expect(outcome.errorCount).toBeGreaterThanOrEqual(1);
    expect(outcome.lastError).toMatch(/facebook/i);
    expect(outcome.lastError).toMatch(/abandoned/i);
    // The sweep still reached the tenant's other platform.
    expect(vi.mocked(reverifyLinkedin)).toHaveBeenCalledWith(tenantId);
    expect(outcome.accountsChecked).toBeGreaterThanOrEqual(2);
    // The offender is identifiable: tenant + platform + error are recorded.
    const failure = outcome.recentFailures.find(
      (f) => f.tenantId === tenantId && f.platform === "facebook",
    );
    expect(failure).toBeDefined();
    expect(failure!.error).toMatch(/abandoned/i);
    expect(new Date(failure!.at).getTime()).toBeGreaterThan(0);
  });
});
