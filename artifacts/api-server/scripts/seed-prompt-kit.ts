/**
 * One-off seed for the Prompt Template Kit: one case type per real flow key,
 * each with a template whose v1 is live in production, plus a saved test
 * case for the caption flow. Idempotent: skips any case slug that already
 * exists. Run: pnpm exec tsx scripts/seed-prompt-kit.ts
 */
import {
  db,
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
  promptTestCasesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { SEEDS } from "../src/lib/promptKitSeeds";

async function main() {
  for (const seed of SEEDS) {
    const existing = await db
      .select({ id: promptCaseTypesTable.id })
      .from(promptCaseTypesTable)
      .where(eq(promptCaseTypesTable.slug, seed.slug))
      .limit(1);
    if (existing.length > 0) {
      console.log(`skip ${seed.slug} (exists)`);
      continue;
    }
    const [caseType] = await db
      .insert(promptCaseTypesTable)
      .values({
        name: seed.name,
        slug: seed.slug,
        description: seed.description,
        riskLevel: seed.riskLevel,
        approvalRequired: seed.riskLevel === "high",
        flowKey: seed.flowKey,
        status: "active",
      })
      .returning();
    const [template] = await db
      .insert(promptTemplatesTable)
      .values({
        caseTypeId: caseType!.id,
        title: seed.templateTitle,
        description: seed.description,
        status: "active",
        createdBy: "seed",
      })
      .returning();
    const [version] = await db
      .insert(promptTemplateVersionsTable)
      .values({
        templateId: template!.id,
        caseTypeId: caseType!.id,
        versionNo: 1,
        contentSnapshot: seed.blocks,
        configSnapshot: {},
        changeNotes: "Initial seeded version",
        lifecycleState: "production",
        createdBy: "seed",
        approvedBy: seed.riskLevel === "high" ? "seed" : null,
        approvedAt: seed.riskLevel === "high" ? new Date() : null,
      })
      .returning();
    await db
      .update(promptTemplatesTable)
      .set({ activeProductionVersionId: version!.id })
      .where(eq(promptTemplatesTable.id, template!.id));
    if (seed.flowKey === "caption") {
      await db.insert(promptTestCasesTable).values({
        caseTypeId: caseType!.id,
        title: "Diwali sweets launch",
        inputJson: {
          userInput:
            "Announce our new Diwali sweets gift box with early-bird pricing",
          placeholders: { platform: "instagram", tone: "warm and festive" },
        },
        expectedNotes:
          "Festive hook, mentions the gift box and early-bird offer, warm tone, no restricted claims.",
        createdBy: "seed",
      });
    }
    console.log(`seeded ${seed.slug} -> template ${template!.id} v1 production`);
  }
  process.exit(0);
}

// Only run when executed directly (tests import SEEDS without seeding).
if (process.argv[1]?.includes("seed-prompt-kit")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
