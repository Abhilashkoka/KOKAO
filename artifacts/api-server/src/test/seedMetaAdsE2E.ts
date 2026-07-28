/* eslint-disable no-console */
// One-off e2e seeding: give the tenant identified by email a connected Meta
// Ads connection pointing at the local Graph mock (act_777001).
// Usage: pnpm --filter @workspace/api-server exec tsx src/test/seedMetaAdsE2E.ts <email>
import { db, tenantsTable, adAccountConnectionsTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { encryptJson } from "../lib/secretCrypto";

const email = process.argv[2]?.toLowerCase();
if (!email) {
  console.error("usage: tsx seedMetaAdsE2E.ts <email>");
  process.exit(2);
}

async function main() {
  let tenant: { id: number } | undefined;
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(sql`lower(${tenantsTable.email}) = ${email}`);
    tenant = rows[0];
    if (tenant) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!tenant) throw new Error("tenant not found for " + email);

  const existing = await db
    .select({ id: adAccountConnectionsTable.id })
    .from(adAccountConnectionsTable)
    .where(
      and(
        eq(adAccountConnectionsTable.tenantId, tenant.id),
        eq(adAccountConnectionsTable.platform, "meta"),
      ),
    );
  const values = {
    tenantId: tenant.id,
    platform: "meta",
    adAccountId: "act_777001",
    adAccountName: "KOKAO Test Ad Account",
    currency: "USD",
    status: "connected",
    encryptedCredentials: encryptJson({ accessToken: "mock-meta-ads-token" }),
    verifyStatus: "verified",
    verifiedAt: new Date(),
    verifyError: null as string | null,
  };
  if (existing[0]) {
    await db
      .update(adAccountConnectionsTable)
      .set(values)
      .where(eq(adAccountConnectionsTable.id, existing[0].id));
    console.log("updated connection", existing[0].id, "tenant", tenant.id);
  } else {
    const [row] = await db
      .insert(adAccountConnectionsTable)
      .values(values)
      .returning({ id: adAccountConnectionsTable.id });
    console.log("inserted connection", row.id, "tenant", tenant.id);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
