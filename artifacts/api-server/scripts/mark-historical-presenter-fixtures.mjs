import pg from "pg";

// A one-time, reversible quarantine of the exact legacy seedPresenterTemplate
// shape. No name-only matching, no deletions, and no partial JSON comparisons.
const slotsFor = (required) => [
  { kind: "presenter_video", required, label: "A presenter video" },
  { kind: "script", required: true, label: "The script spoken in the video" },
];
const defaults = {
  aspectRatio: "9:16",
  visualsSource: "stock",
  captionStyle: "dynamic",
  reviewStoryboard: true,
};
const payload = {
  version: 1,
  hookShape: "presenter opens direct to camera",
  pacing: { sceneCount: 1, avgSceneSec: 60, wordsPerMinute: 145 },
  captionStyle: "dynamic",
  energy: "clear",
  visualNotes: ["upper-frame B-roll"],
  scriptGuidance: "Use the submitted script exactly.",
  sourceDurationSec: 60,
  transcriptExcerpt: "",
};
const params = [
  JSON.stringify(slotsFor(true)),
  JSON.stringify(slotsFor(false)),
  JSON.stringify(defaults),
  JSON.stringify(payload),
];
const fingerprint = `
  tenant_id IS NULL AND scope = 'platform' AND source_kind = 'curated'
  AND published = true AND source_video_path IS NULL
  AND name ~ '^Presenter B-roll [0-9]{13}-[0-9]+$'
  AND summary = 'Talking-head presenter with timed supporting B-roll.'
  AND (slots = $1::jsonb OR slots = $2::jsonb)
  AND job_defaults = $3::jsonb AND payload = $4::jsonb
`;
const apply = process.argv.slice(2).includes("--apply");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  if (apply) {
    const lock = await client.query("SELECT pg_try_advisory_lock(913874220) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error("API test run holds the shared database lock; retry after it finishes.");
  }
  await client.query("BEGIN");
  const candidates = await client.query(
    `SELECT id, name FROM video_style_profiles WHERE ${fingerprint} ORDER BY id ${apply ? "FOR UPDATE" : ""}`,
    params,
  );
  console.log(`Exact unmarked presenter fixtures: ${candidates.rowCount ?? 0}`);
  console.log("IDs:", candidates.rows.map(({ id }) => id));
  if (apply && candidates.rowCount) {
    const result = await client.query(
      `UPDATE video_style_profiles
       SET payload = jsonb_set(payload, '{__kokaoApiTestFixture}', '"historical-presenter-v1"'::jsonb)
       WHERE id = ANY($5::int[]) AND ${fingerprint}
       RETURNING id`,
      [...params, candidates.rows.map(({ id }) => id)],
    );
    if (result.rowCount !== candidates.rowCount) throw new Error("Candidates changed; rolling back.");
    console.log(`Marked ${result.rowCount} exact historical fixtures (no deletion).`);
  }
  await client.query(apply ? "COMMIT" : "ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}