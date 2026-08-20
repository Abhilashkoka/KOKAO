/**
 * Emit the seeded Prompt Kit content as an importable bundle, without touching
 * the database.
 *
 * Why this exists: `seed-prompt-kit.ts` skips any case slug that already
 * exists, so it can only ever create the FIRST version of a prompt. An
 * environment that was seeded months ago will never pick up an improved
 * template from it. The bundle path can: POST /admin/prompt-kit/import
 * upserts by slug and adds a NEW version, which an admin then reviews in the
 * playground and promotes when they are happy with it.
 *
 * Run: pnpm exec tsx scripts/export-prompt-kit-bundle.ts > bundle.json
 */
import { SEEDS } from "../src/lib/promptKitSeeds";

const BUNDLE_FORMAT = "kokao-prompt-kit";
const BUNDLE_FORMAT_VERSION = 1;

/**
 * Versions land as `draft`, never `production`.
 *
 * An import that promoted itself would silently replace the live prompt of
 * every environment it touched. A human compares old against new in the
 * playground and promotes deliberately.
 */
const bundle = {
  format: BUNDLE_FORMAT,
  formatVersion: BUNDLE_FORMAT_VERSION,
  cases: SEEDS.map((seed) => ({
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
              "Imported from promptKitSeeds. Review in the playground, then promote.",
            lifecycleState: "draft" as const,
            createdBy: "bundle",
          },
        ],
      },
    ],
  })),
};

process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
