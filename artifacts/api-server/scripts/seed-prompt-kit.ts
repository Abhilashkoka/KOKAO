/**
 * One-off seed for the Prompt Template Kit: 4 case types (one per flow),
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
  type PromptBlock,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const SEEDS: Array<{
  slug: string;
  name: string;
  description: string;
  flowKey: "caption" | "image" | "campaign" | "video_script";
  riskLevel: "low" | "high";
  templateTitle: string;
  blocks: PromptBlock[];
}> = [
  {
    slug: "everyday-caption",
    name: "Everyday caption",
    description: "Day-to-day single-platform caption writing.",
    flowKey: "caption",
    riskLevel: "low",
    templateTitle: "Everyday caption v-base",
    blocks: [
      {
        id: "blk_role",
        title: "Role",
        content:
          "You are a senior {{platform}} copywriter with a decade of hands-on niche experience. Write one caption plus a short creative-brief title (3-8 words).",
        mandatory: true,
        order: 1,
      },
      {
        id: "blk_quality",
        title: "Quality bar",
        content:
          "Open with a strong hook, write like a human expert (specific, concrete, no fluff), and match the requested tone exactly.",
        mandatory: true,
        order: 2,
      },
      {
        id: "blk_extras",
        title: "Optional flourishes",
        content: "Where natural, end with a light call-to-action question.",
        mandatory: false,
        order: 3,
      },
    ],
  },
  {
    slug: "brand-image",
    name: "Brand image",
    description: "AI image generation guidance for on-brand visuals.",
    flowKey: "image",
    riskLevel: "low",
    templateTitle: "Brand image v-base",
    blocks: [
      {
        id: "blk_style",
        title: "Visual style",
        content:
          "Produce a clean, professional social-media visual: strong single subject, uncluttered composition, natural lighting, no text overlays unless asked.",
        mandatory: true,
        order: 1,
      },
    ],
  },
  {
    slug: "multi-platform-campaign",
    name: "Multi-platform campaign",
    description: "Coordinated campaign copy across several platforms.",
    flowKey: "campaign",
    riskLevel: "high",
    templateTitle: "Campaign master v-base",
    blocks: [
      {
        id: "blk_role",
        title: "Role",
        content:
          "You are a senior social media strategist running a multi-platform campaign for {{platforms}}. Draft the roomiest platform first, then condense down without losing the core hook.",
        mandatory: true,
        order: 1,
      },
      {
        id: "blk_consistency",
        title: "Consistency",
        content:
          "Every platform variant must carry the same core message and offer; adapt format and length, never the substance.",
        mandatory: true,
        order: 2,
      },
    ],
  },
  {
    slug: "topic-video-script",
    name: "Topic video script",
    description: "Narration scripts for short vertical videos.",
    flowKey: "video_script",
    riskLevel: "low",
    templateTitle: "Video narration v-base",
    blocks: [
      {
        id: "blk_voice",
        title: "Narration voice",
        content:
          "You write narration for short vertical videos: spoken words only, straight to the point, no markdown, no speaker labels, same language as the topic.",
        mandatory: true,
        order: 1,
      },
    ],
  },
];

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
