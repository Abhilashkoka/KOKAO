import { Router, type IRouter } from "express";
import { db, videoPublishesTable, adminAuditLogsTable } from "@workspace/db";
import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { videoPublishAuth } from "../lib/videoPublishAuth";
import { inspectVideoUpload, type VideoUpload } from "../lib/videoPublishProviders";
import { finishUpload } from "../lib/videoPublisher";

export const safeUpload = (row: VideoUpload) => ({
  id: row.id, tenantId: row.tenantId, contentItemId: row.contentItemId,
  platform: row.platform, state: row.state, externalId: row.externalId,
  containerId: row.containerId, accountId: row.accountId,
  hasSession: Boolean(row.encryptedSession), metadata: row.metadata,
  updatedAt: row.updatedAt.toISOString(), lastAttemptAt: row.lastAttemptAt.toISOString(),
});
const resolution = z.object({
  expectedUpdatedAt: z.iso.datetime(),
  outcome: z.enum(["published", "failed"]),
  ownerCheckedDestination: z.literal(true),
}).strict();
const router: IRouter = Router();
// Owners are always tenant-scoped. Cross-tenant requests require live superadmin verification.
router.use("/video-publish-support", (req, res, next) => {
  if (req.memberRole === "owner" && req.query.tenantId === undefined) { next(); return; }
  return requireSuperadmin(req, res, next);
});
router.get("/video-publish-support", async (req, res) => {
  const tenantId = req.query.tenantId === undefined ? req.tenantId : Number(req.query.tenantId);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) { res.status(400).json({ error: "Invalid workspace ID" }); return; }
  const rows = await db.select().from(videoPublishesTable).where(and(eq(videoPublishesTable.tenantId, tenantId), inArray(videoPublishesTable.state, ["attention", "failed"]))).orderBy(desc(videoPublishesTable.updatedAt)).limit(100);
  res.json(rows.map(safeUpload));
});
router.post("/video-publish-support/:tenantId/:id/:action", (req, res, next) => {
  if (req.memberRole === "owner" && Number(req.params.tenantId) === req.tenantId) { next(); return; }
  return requireSuperadmin(req, res, next);
}, async (req, res) => {
  const id = Number(req.params.id);
  const tenantId = Number(req.params.tenantId);
  const action = req.params.action;
  const parsed = resolution.safeParse(req.body);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(tenantId) || tenantId <= 0 || !["reconcile", "resolve"].includes(action) || (action === "resolve" && !parsed.success)) {
    res.status(400).json({ error: "Invalid request. Confirm the owner checked the destination." }); return;
  }
  try {
    const result = await db.transaction(async tx => {
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(72123, ${id}) as locked`);
      if (!(lock.rows[0] as { locked: boolean }).locked) return { status: 409, body: { error: "Upload is busy. Refresh and try again." } };
      const [row] = await tx.select().from(videoPublishesTable).where(and(eq(videoPublishesTable.id, id), eq(videoPublishesTable.tenantId, tenantId))).for("update");
      if (!row) return { status: 404, body: { error: "Upload not found" } };
      if (!["attention", "failed"].includes(row.state)) return { status: 409, body: { error: "Only uploads needing attention can be resolved." } };
      if (action === "reconcile") {
        // Read-only even locally: results never requeue or commit provider work.
        if (!row.externalId && !(row.platform === "instagram" && row.containerId)) return { status: 200, body: { outcome: "unresolved" } };
        const auth = await videoPublishAuth(tenantId, row.platform);
        if (auth.accountId !== row.accountId) return { status: 409, body: { error: "Reconnect the original destination before checking status." } };
        return { status: 200, body: { outcome: await inspectVideoUpload(row, auth.token) } };
      }
      const input = parsed.data!;
      if (row.updatedAt.toISOString() !== input.expectedUpdatedAt) return { status: 409, body: { error: "Upload changed. Refresh before resolving." } };
      const [updated] = await tx.update(videoPublishesTable).set({
        state: input.outcome, error: input.outcome === "failed" ? "Owner confirmed this upload did not publish. Automatic resubmission remains blocked." : null,
        updatedAt: new Date(),
      }).where(eq(videoPublishesTable.id, id)).returning();
      // Required audit, atomic with the resolution. Never record tokens, session URLs or free-form secrets.
      await tx.insert(adminAuditLogsTable).values({
        action: "video_publish_resolution", actorTenantId: req.tenantId, actorEmail: req.tenantEmail,
        targetTenantId: tenantId, targetEmail: null,
        oldValue: JSON.stringify({ uploadId: id, state: row.state }),
        newValue: JSON.stringify({ uploadId: id, state: updated.state, ownerCheckedDestination: true, actorUserId: req.clerkUserId }),
      });
      await finishUpload(updated, tx);
      return { status: 200, body: safeUpload(updated) };
    });
    res.status(result.status).json(result.body);
  } catch {
    res.status(503).json({ error: "Status check or resolution unavailable. No new upload was started. Reconnect the original account if needed, then refresh." });
  }
});
export default router;