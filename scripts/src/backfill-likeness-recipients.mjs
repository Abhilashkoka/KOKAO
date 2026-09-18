// Backfill: move recipients off likeness grant columns into the append-only
// disclosure ledger.
//
// Run order:
//   1. lib/db/sql/2026-09-18_universal_likeness_attestation.sql
//   2. node scripts/src/backfill-likeness-recipients.mjs   <- this file
//   3. lib/db/sql/2026-09-18_universal_likeness_attestation_cleanup.sql
//
// Why a script and not SQL: image_processor_scope stores human labels like
// "outfit|OpenAI (built in, no key needed) / gpt-image-1". Recovering the
// provider id from that in SQL would be brittle string surgery, so the mapping
// is done here against the real provider catalog labels.
//
// Idempotent: every insert is ON CONFLICT DO NOTHING against the disclosure
// uniqueness index, so re-running is safe.
//
// Usage: node scripts/src/backfill-likeness-recipients.mjs [--dry-run]
import { createRequire } from "node:module";

const require_ = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
);
const { Pool } = require_("pg");

const DRY_RUN = process.argv.includes("--dry-run");
const ACTOR = "system:backfill-likeness-recipients";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

/**
 * Provider label -> provider id, exactly as personalProcessorLabel() built the
 * scope strings (`${def.label} / ${model}`). Keep in sync with
 * IMAGE_GEN_PROVIDERS in artifacts/api-server/src/lib/imageGen/index.ts; an
 * unmatched label is reported rather than guessed.
 */
const IMAGE_PROVIDER_LABELS = {
  "OpenAI (built in, no key needed)": "openai",
  "Google Gemini": "gemini",
  "Black Forest Labs (FLUX)": "bfl",
  "ByteDance Seedream": "seedream",
  "Stability AI": "stability",
  Replicate: "replicate",
  "OpenRouter (routes to many image models)": "openrouter",
  Higgsfield: "higgsfield",
  "NVIDIA API Catalog / image NIM": "nvidia",
};

/** The two exact Atlas contracts a legacy providers:["atlascloud"] grant covered. */
const LEGACY_ATLAS_VIDEO_MODELS = [
  "alibaba/wan-3.0/reference-to-video",
  "alibaba/wan-3.0-prime/reference-to-video",
];

/** "outfit|OpenAI (built in, no key needed) / gpt-image-1" -> parts. */
function parseScopeLabel(scopeLabel) {
  const pipe = scopeLabel.indexOf("|");
  if (pipe < 0) return null;
  const operation = scopeLabel.slice(0, pipe);
  const rest = scopeLabel.slice(pipe + 1);
  // Split on the LAST " / " so a model id containing a slash survives.
  const sep = rest.lastIndexOf(" / ");
  if (sep < 0) return null;
  const label = rest.slice(0, sep);
  const model = rest.slice(sep + 3);
  const provider = IMAGE_PROVIDER_LABELS[label];
  if (!provider || !model) return null;
  if (operation !== "reference_sheet" && operation !== "outfit") return null;
  return { operation, provider, model, scopeLabel };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  const stats = {
    grants: 0,
    imageDisclosures: 0,
    videoDisclosures: 0,
    unparsedScopes: [],
  };
  try {
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'character_likeness_consent_grants'
          AND column_name IN ('providers', 'image_processor_scope')`,
    );
    if (columns.rowCount === 0) {
      console.log(
        "Legacy providers/image_processor_scope columns are already gone. " +
          "Nothing to backfill; the cleanup migration has run.",
      );
      return;
    }

    const { rows: grants } = await client.query(
      `SELECT id, tenant_id, character_id, providers, image_processor_scope
         FROM character_likeness_consent_grants
        ORDER BY id`,
    );
    console.log(`Found ${grants.length} grant(s).`);

    for (const grant of grants) {
      stats.grants += 1;
      const inserts = [];

      for (const scopeLabel of grant.image_processor_scope ?? []) {
        const parsed = parseScopeLabel(String(scopeLabel));
        if (!parsed) {
          stats.unparsedScopes.push({ grantId: grant.id, scopeLabel });
          continue;
        }
        inserts.push(parsed);
      }

      // A legacy grant listing atlascloud authorized exactly the two documented
      // Wan reference-to-video contracts, and never the Atlas Asset Library.
      if ((grant.providers ?? []).includes("atlascloud")) {
        for (const model of LEGACY_ATLAS_VIDEO_MODELS) {
          inserts.push({
            operation: "video",
            provider: "atlascloud",
            model,
            scopeLabel: `video|Atlas Cloud / ${model}`,
          });
        }
      }

      for (const entry of inserts) {
        if (DRY_RUN) {
          console.log(
            `  [dry-run] grant ${grant.id} -> ${entry.operation} ${entry.provider} / ${entry.model}`,
          );
        } else {
          await client.query(
            `INSERT INTO character_likeness_recipient_disclosures
               (tenant_id, character_id, consent_id, provider, model, operation,
                scope_label, acting_clerk_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (tenant_id, consent_id, provider, model, operation)
               DO NOTHING`,
            [
              grant.tenant_id,
              grant.character_id,
              grant.id,
              entry.provider,
              entry.model,
              entry.operation,
              entry.scopeLabel,
              ACTOR,
            ],
          );
        }
        if (entry.operation === "video") stats.videoDisclosures += 1;
        else stats.imageDisclosures += 1;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log("");
  console.log(`grants processed:     ${stats.grants}`);
  console.log(`image disclosures:    ${stats.imageDisclosures}`);
  console.log(`video disclosures:    ${stats.videoDisclosures}`);
  if (stats.unparsedScopes.length) {
    console.log("");
    console.log(
      `WARNING: ${stats.unparsedScopes.length} scope label(s) could not be mapped to a ` +
        "catalogued provider. Do NOT run the cleanup migration yet; those users would " +
        "silently need to re-acknowledge their image recipients:",
    );
    for (const entry of stats.unparsedScopes) {
      console.log(`  grant ${entry.grantId}: ${entry.scopeLabel}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log(
    DRY_RUN
      ? "Dry run complete. Re-run without --dry-run to write."
      : "Backfill complete. Safe to run the cleanup migration.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
