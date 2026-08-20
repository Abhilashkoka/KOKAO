/**
 * Emit only the four additive Spokesperson script cases as an importable
 * Prompt Kit bundle, without touching the database.
 *
 * This file deliberately excludes every existing base Prompt Kit case.
 * Importing a broad seed bundle into a populated environment can update a
 * matching version number and clear that template's production pointer. These
 * four slugs are new cases, and every bundled version lands as a draft for
 * explicit review and promotion.
 *
 * Run from artifacts/api-server:
 * pnpm exec tsx scripts/export-script-variants-bundle.ts \
 *   > scripts/script-variants-bundle.json
 */
import { SEEDS } from "../src/lib/promptKitSeeds";

const BUNDLE_FORMAT = "kokao-prompt-kit";
const BUNDLE_FORMAT_VERSION = 1;
const SCRIPT_VARIANT_SLUGS = [
  "video-script-marketing",
  "video-script-training",
  "video-script-social-short",
  "video-script-intake",
] as const;
const allowedSlugs = new Set<string>(SCRIPT_VARIANT_SLUGS);
const seeds = SEEDS.filter((seed) => allowedSlugs.has(seed.slug));

if (
  seeds.length !== SCRIPT_VARIANT_SLUGS.length ||
  seeds.some((seed) => !allowedSlugs.has(seed.slug))
) {
  throw new Error(
    "Script-variant bundle seeds do not match the four additive Prompt Kit cases",
  );
}

const bundle = {
  format: BUNDLE_FORMAT,
  formatVersion: BUNDLE_FORMAT_VERSION,
  cases: seeds.map((seed) => ({
    slug: seed.slug,
    name: seed.name,
    description: seed.description,
    riskLevel: seed.riskLevel,
    approvalRequired: seed.riskLevel === "high",
    flowKey: seed.flowKey,
    variantKey: seed.variantKey ?? null,
    tags: [],
    status: "active" as const,
    templates: [
      {
        title: seed.templateTitle,
        description: seed.description,
        status: "active" as const,
        productionVersionNo: null,
        stagingVersionNo: null,
        createdBy: "bundle",
        versions: [
          {
            versionNo: 1,
            blocks: seed.blocks,
            config: {},
            changeNotes:
              "Imported as an additive script case. Review in the playground, then promote.",
            lifecycleState: "draft" as const,
            createdBy: "bundle",
          },
        ],
      },
    ],
  })),
};

process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);