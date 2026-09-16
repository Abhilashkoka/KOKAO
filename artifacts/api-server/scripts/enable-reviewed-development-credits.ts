/**
 * Explicit development-only saved-rate activation. Does not change prices,
 * balances, legacy estimates, or the production release decision.
 */
import {
  db, pool, creditMeterSettingsTable, creditRatesTable, adminAuditLogsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  validateCreditRateCard, invalidateCreditRateCache, getMeterMode,
} from "../src/lib/creditRates";
import { getCreditEnforcementDecision } from "../src/lib/creditReconciliationGate";
import { isCreditFunded } from "../src/lib/creditAccounts";

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--confirm-saved-rate-development") {
    throw new Error("Explicit reviewed development activation confirmation is required.");
  }
  const decision = getCreditEnforcementDecision();
  if (!decision.allowed || decision.scope !== "development") {
    throw new Error("This script can activate only the approved development environment.");
  }
  const result = await db.transaction(async (tx) => {
    const [settings] = await tx.select().from(creditMeterSettingsTable)
      .where(eq(creditMeterSettingsTable.id, 1)).for("update");
    if (!settings || !["shadow", "enforce"].includes(settings.mode)) {
      throw new Error("Expected an existing shadow or enforced saved rate card.");
    }
    // Include protection against new rows as well as changes to existing rows.
    await tx.execute(sql`LOCK TABLE credit_rates IN SHARE MODE`);
    const rows = await tx.select().from(creditRatesTable);
    validateCreditRateCard({
      mode: "enforce",
      creditPricePaise: settings.creditPricePaise ?? 0,
      rates: rows.map((row) => ({
        key: row.key, label: row.label, unit: row.unit,
        credits: row.creditsMilli / 1000, active: row.active,
        sortOrder: row.sortOrder, notes: row.notes,
      })),
    });
    const stillAllowed = getCreditEnforcementDecision();
    if (!stillAllowed.allowed || stillAllowed.scope !== "development") {
      throw new Error("Development authorization changed.");
    }
    if (settings.mode !== "enforce") {
      await tx.update(creditMeterSettingsTable)
        .set({ mode: "enforce", updatedAt: new Date() })
        .where(eq(creditMeterSettingsTable.id, 1));
      await tx.insert(adminAuditLogsTable).values({
        action: "credit_rates_change",
        actorTenantId: 4,
        targetTenantId: null,
        oldValue: JSON.stringify({ mode: settings.mode }),
        newValue: JSON.stringify({
          mode: "enforce",
          scope: "development",
          authorization: "User-approved saved-rate activation after billing-behavior verification",
          productionGateChanged: false,
          pricesChanged: false,
          legacyEstimatesChanged: false,
        }),
      });
    }
    return { activated: true, alreadyEnabled: settings.mode === "enforce", rateCount: rows.length };
  });
  invalidateCreditRateCache();
  console.log(JSON.stringify({
    ...result,
    effectiveMode: await getMeterMode(),
    workspaceCreditFunded: await isCreditFunded(4),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => pool.end());