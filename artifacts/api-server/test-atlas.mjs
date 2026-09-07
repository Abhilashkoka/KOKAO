import pg from "pg";

const key = process.env.ATLASCLOUD_API_KEY;
if (!key) { console.error("Set ATLASCLOUD_API_KEY first."); process.exit(1); }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(
  "SELECT id, name, reference_image_path FROM characters ORDER BY id LIMIT 3"
);
await c.end();
if (!rows.length) { console.error("No characters in the database."); process.exit(1); }

let dir = process.env.PRIVATE_OBJECT_DIR || "";
if (!dir.endsWith("/")) dir += "/";

const atlas = (path, init) =>
  fetch("https://console.atlascloud.ai/api/v1" + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.text() }));

for (const row of rows) {
  console.log(`\n${row.name} (#${row.id})`);
  const entity = row.reference_image_path.slice(1).split("/").slice(1).join("/");
  const parts = ("/" + (dir + entity).replace(/^\/+/, "")).split("/");

  const sr = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: parts[1],
      object_name: parts.slice(2).join("/"),
      method: "GET",
      expires_at: new Date(Date.now() + 900000).toISOString(),
    }),
  });
  if (!sr.ok) { console.log("  signed URL FAILED", sr.status); continue; }
  console.log("  signed URL ok");

  const reg = await atlas("/sd/assets", {
    method: "POST",
    body: JSON.stringify({ type: "Image", url: (await sr.json()).signed_url }),
  });
  if (!reg.ok) { console.log(`  register FAILED ${reg.status}`, reg.body.slice(0, 300)); continue; }
  const id = JSON.parse(reg.body).id;
  console.log("  register ok —", id);

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await atlas(`/sd/assets/${id}`);
    const b = JSON.parse(s.body || "{}");
    const st = String(b.status || "").toLowerCase();
    if (st === "active") { console.log(`  STATUS: ACTIVE  ->  asset://${id}`); break; }
    if (st === "failed" || st === "rejected") {
      console.log("  STATUS: REJECTED —", b.error_message || b.error || b.error_code || "no reason");
      break;
    }
    if (i === 23) console.log("  STATUS: timed out still processing");
  }
}
