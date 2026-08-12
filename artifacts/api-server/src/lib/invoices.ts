import {
  db,
  billingProfilesTable,
  invoiceSettingsTable,
  invoicesTable,
  tenantsTable,
  type InvoiceParty,
  type InvoiceRow,
  type InvoiceSettings,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { logger } from "./logger";

/**
 * Tax invoices for real-money payments.
 *
 * `recordInvoice` is called from every verified terminal PAID path (verify
 * routes AND webhook backstops). It is idempotent on (kind, refId) and
 * BEST-EFFORT: a failure here must never fail the payment itself — the money
 * has already moved, so we log and move on.
 *
 * Numbering: "<prefix>/<FY>/<seq>" where FY is the Indian financial year
 * (Apr–Mar, e.g. "2026-27") and seq restarts at 1 each FY. The settings row
 * is locked FOR UPDATE while a number is taken, so numbers are unique and
 * gapless under concurrency.
 */

export type InvoiceKind = "wallet_topup" | "credit_pack" | "plan";

export interface RecordInvoiceParams {
  tenantId: number;
  kind: InvoiceKind;
  /** Gateway order/subscription id (plus payment id for renewals) — idempotency key with kind. */
  refId: string;
  gateway: "razorpay" | "cashfree";
  description: string;
  /** GST-exclusive base. When no split is known, pass total here and gst 0. */
  baseAmountPaise: number;
  gstAmountPaise?: number;
  gstPercent?: number;
  totalPaise: number;
}

/** Indian financial year label for a date, e.g. "2026-27". */
export function financialYearLabel(d: Date): string {
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const [row] = await db.select().from(invoiceSettingsTable).limit(1);
  if (row) return row;
  // The unique index on `singleton` makes this a hard DB-level singleton:
  // concurrent first calls collide and one seeds the row, the rest no-op.
  await db.insert(invoiceSettingsTable).values({}).onConflictDoNothing();
  const [seeded] = await db.select().from(invoiceSettingsTable).limit(1);
  return seeded;
}

export async function updateInvoiceSettings(changes: {
  legalName?: string;
  gstin?: string | null;
  address?: string | null;
  numberPrefix?: string;
}): Promise<InvoiceSettings> {
  const current = await getInvoiceSettings();
  const [updated] = await db
    .update(invoiceSettingsTable)
    .set(changes)
    .where(eq(invoiceSettingsTable.id, current.id))
    .returning();
  return updated;
}

async function buildBuyer(tenantId: number): Promise<InvoiceParty> {
  const [profile] = await db
    .select()
    .from(billingProfilesTable)
    .where(eq(billingProfilesTable.tenantId, tenantId))
    .limit(1);
  const [tenant] = await db
    .select({ name: tenantsTable.name, email: tenantsTable.email })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);
  return {
    legalName:
      profile?.businessName?.trim() ||
      tenant?.name ||
      tenant?.email ||
      `Workspace ${tenantId}`,
    gstin: profile?.gstin ?? null,
    address: profile?.address ?? null,
  };
}

/**
 * Create the invoice for a verified paid payment. Idempotent; best-effort.
 * Returns the invoice row (existing or new), or null when creation failed.
 */
export async function recordInvoice(
  params: RecordInvoiceParams,
): Promise<InvoiceRow | null> {
  try {
    // Cheap fast path — the common repeat call (webhook after verify).
    const [existing] = await db
      .select()
      .from(invoicesTable)
      .where(
        and(eq(invoicesTable.kind, params.kind), eq(invoicesTable.refId, params.refId)),
      )
      .limit(1);
    if (existing) return existing;

    const settingsRow = await getInvoiceSettings(); // seeds the singleton
    const buyer = await buildBuyer(params.tenantId);

    return await db.transaction(async (tx) => {
      // Every issuer serializes on this lock, so the existence re-check,
      // number take, insert and counter bump are one atomic unit — no
      // duplicate numbers and no skipped (wasted) numbers when two paths
      // race on the same payment.
      const [locked] = await tx
        .select()
        .from(invoiceSettingsTable)
        .where(eq(invoiceSettingsTable.id, settingsRow.id))
        .for("update");
      const [already] = await tx
        .select()
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.kind, params.kind),
            eq(invoicesTable.refId, params.refId),
          ),
        )
        .limit(1);
      if (already) return already;

      const fy = financialYearLabel(new Date());
      const seq = locked.counterFy === fy ? locked.nextSeq : 1;
      const invoiceNumber = `${locked.numberPrefix}/${fy}/${String(seq).padStart(4, "0")}`;
      const seller: InvoiceParty = {
        legalName: locked.legalName,
        gstin: locked.gstin,
        address: locked.address,
      };
      const [created] = await tx
        .insert(invoicesTable)
        .values({
          tenantId: params.tenantId,
          invoiceNumber,
          kind: params.kind,
          refId: params.refId,
          gateway: params.gateway,
          description: params.description,
          baseAmountPaise: params.baseAmountPaise,
          gstAmountPaise: params.gstAmountPaise ?? 0,
          gstPercent: params.gstPercent ?? 0,
          totalPaise: params.totalPaise,
          seller,
          buyer,
        })
        .returning();
      // Advance the counter only for a row that was actually inserted.
      await tx
        .update(invoiceSettingsTable)
        .set({ counterFy: fy, nextSeq: seq + 1 })
        .where(eq(invoiceSettingsTable.id, locked.id));
      return created;
    });
  } catch (err) {
    logger.error(
      { err, kind: params.kind, refId: params.refId, tenantId: params.tenantId },
      "invoice creation failed (payment unaffected)",
    );
    return null;
  }
}

export async function listInvoices(tenantId: number): Promise<InvoiceRow[]> {
  return db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.tenantId, tenantId))
    .orderBy(desc(invoicesTable.issuedAt), desc(invoicesTable.id));
}

export async function getInvoice(
  tenantId: number,
  id: number,
): Promise<InvoiceRow | null> {
  const [row] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, id), eq(invoicesTable.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

// ---------- PDF ----------

const rupees = (paise: number) =>
  `Rs. ${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Render an invoice as a simple single-page A4 PDF. */
export async function renderInvoicePdf(inv: InvoiceRow): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 portrait, points
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.13, 0.16);
  const muted = rgb(0.45, 0.45, 0.5);
  const line = rgb(0.85, 0.85, 0.88);
  const left = 50;
  const right = 545;
  let y = 790;

  const text = (
    s: string,
    x: number,
    yy: number,
    opts: { size?: number; font?: typeof font; color?: typeof ink; alignRight?: boolean } = {},
  ) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 10;
    const w = f.widthOfTextAtSize(s, size);
    page.drawText(s, {
      x: opts.alignRight ? x - w : x,
      y: yy,
      size,
      font: f,
      color: opts.color ?? ink,
    });
  };
  const wrap = (s: string, max = 60): string[] =>
    s.split("\n").flatMap((ln) => {
      const out: string[] = [];
      let cur = "";
      for (const word of ln.split(/\s+/)) {
        if ((cur + " " + word).trim().length > max) {
          if (cur) out.push(cur);
          cur = word;
        } else cur = (cur + " " + word).trim();
      }
      if (cur) out.push(cur);
      return out.length ? out : [""];
    });

  const isTaxInvoice = inv.gstAmountPaise > 0;
  text(isTaxInvoice ? "TAX INVOICE" : "INVOICE", left, y, { size: 20, font: bold });
  text(inv.invoiceNumber, right, y + 4, { alignRight: true, size: 12, font: bold });
  text(
    `Date: ${inv.issuedAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`,
    right,
    y - 12,
    { alignRight: true, color: muted },
  );
  y -= 40;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: line });
  y -= 24;

  const party = (label: string, p: typeof inv.seller, x: number) => {
    let py = y;
    text(label, x, py, { size: 8, color: muted, font: bold });
    py -= 14;
    text(p.legalName, x, py, { font: bold, size: 11 });
    py -= 14;
    if (p.gstin) {
      text(`GSTIN: ${p.gstin}`, x, py, { size: 9 });
      py -= 12;
    }
    if (p.address) {
      for (const ln of wrap(p.address, 42)) {
        text(ln, x, py, { size: 9, color: muted });
        py -= 11;
      }
    }
    return py;
  };
  const yA = party("BILLED BY", inv.seller, left);
  const yB = party("BILLED TO", inv.buyer, 320);
  y = Math.min(yA, yB) - 26;

  // Table
  page.drawLine({ start: { x: left, y: y + 14 }, end: { x: right, y: y + 14 }, thickness: 1, color: line });
  text("DESCRIPTION", left, y, { size: 8, color: muted, font: bold });
  text("AMOUNT", right, y, { size: 8, color: muted, font: bold, alignRight: true });
  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: line });
  y -= 18;
  for (const ln of wrap(inv.description, 70)) {
    text(ln, left, y, { size: 10 });
    y -= 14;
  }
  text(rupees(inv.baseAmountPaise), right, y + 14, { alignRight: true, size: 10 });
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: line });
  y -= 18;
  if (isTaxInvoice) {
    text(`GST (${inv.gstPercent}%)`, 380, y);
    text(rupees(inv.gstAmountPaise), right, y, { alignRight: true });
    y -= 18;
  }
  text("TOTAL", 380, y, { font: bold, size: 12 });
  text(rupees(inv.totalPaise), right, y, { alignRight: true, font: bold, size: 12 });
  y -= 16;
  if (!isTaxInvoice) {
    text("Amount is inclusive of applicable taxes.", left, y, { size: 8, color: muted });
    y -= 12;
  }
  y -= 20;
  text(
    `Payment received via ${inv.gateway === "razorpay" ? "Razorpay" : "Cashfree"} — ref ${inv.refId}`,
    left,
    y,
    { size: 8, color: muted },
  );
  text("This is a computer-generated invoice and does not require a signature.", left, 50, {
    size: 8,
    color: muted,
  });
  return doc.save();
}
