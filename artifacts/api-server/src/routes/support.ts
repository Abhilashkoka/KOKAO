import { Router, type IRouter, type Request, type Response } from "express";
import { db, supportRequestsTable, tenantsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { notifySupportRequestSubmitted } from "../lib/notifications";

const router: IRouter = Router();

const CATEGORIES = ["complaint", "question", "bug", "billing", "other"] as const;

const SupportRequestCreateSchema = z.object({
  category: z.enum(CATEGORIES).default("other"),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(10).max(5000),
});

export function serializeSupportRequest(
  row: typeof supportRequestsTable.$inferSelect,
) {
  return {
    id: row.id,
    category: row.category,
    subject: row.subject,
    message: row.message,
    status: row.status,
    adminReply: row.adminReply ?? null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// List the current tenant's own support requests, newest first.
router.get("/support/requests", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(supportRequestsTable)
    .where(eq(supportRequestsTable.tenantId, req.tenantId))
    .orderBy(desc(supportRequestsTable.createdAt))
    .limit(100);
  res.json(rows.map(serializeSupportRequest));
});

// File a new help & support request. Any signed-in workspace user can
// submit; platform admins are notified best-effort (never blocks the 201).
router.post("/support/requests", async (req: Request, res: Response) => {
  const parsed = SupportRequestCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        "Please provide a subject (3-200 characters) and a message (10-5000 characters).",
    });
    return;
  }

  // Light abuse guard: at most 10 open requests per workspace.
  const open = await db
    .select({ id: supportRequestsTable.id })
    .from(supportRequestsTable)
    .where(
      and(
        eq(supportRequestsTable.tenantId, req.tenantId),
        eq(supportRequestsTable.status, "open"),
      ),
    )
    .limit(10);
  if (open.length >= 10) {
    res.status(400).json({
      error:
        "You already have 10 open requests. Please wait for a reply before filing more.",
    });
    return;
  }

  const inserted = (
    await db
      .insert(supportRequestsTable)
      .values({
        tenantId: req.tenantId,
        submitterEmail: req.tenantEmail ?? null,
        category: parsed.data.category,
        subject: parsed.data.subject,
        message: parsed.data.message,
      })
      .returning()
  )[0];

  const tenant = (
    await db
      .select({ name: tenantsTable.name })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .limit(1)
  )[0];

  await notifySupportRequestSubmitted({
    supportRequestId: inserted.id,
    requestingTenantId: req.tenantId,
    requestingTenantName: tenant?.name ?? `#${req.tenantId}`,
    submitterEmail: req.tenantEmail ?? null,
    category: inserted.category,
    subject: inserted.subject,
  });

  res.status(201).json(serializeSupportRequest(inserted));
});

export default router;
