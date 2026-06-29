import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedAccountsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { CreateAccountBody } from "@workspace/api-zod";
import { serializeAccount } from "../lib/serializers";

const router: IRouter = Router();

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/accounts", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(connectedAccountsTable)
    .where(eq(connectedAccountsTable.tenantId, req.tenantId))
    .orderBy(desc(connectedAccountsTable.createdAt));
  res.json(rows.map(serializeAccount));
});

router.post("/accounts", async (req: Request, res: Response) => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const created = (
    await db
      .insert(connectedAccountsTable)
      .values({ ...parsed.data, tenantId: req.tenantId })
      .returning()
  )[0]!;
  res.status(201).json(serializeAccount(created));
});

router.delete("/accounts/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = (
    await db
      .delete(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.id, id),
          eq(connectedAccountsTable.tenantId, req.tenantId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
