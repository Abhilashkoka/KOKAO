import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  invoicesTable,
  invoiceSettingsTable,
  billingProfilesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  financialYearLabel,
  recordInvoice,
  listInvoices,
  getInvoice,
  renderInvoicePdf,
  getInvoiceSettings,
} from "./invoices";
import { pool } from "@workspace/db";

let tenantId: number;
const refIds: string[] = [];
const ref = (s: string) => {
  const id = `test_inv_${s}_${Date.now()}`;
  refIds.push(id);
  return id;
};

beforeAll(async () => {
  const [t] = await db
    .insert(tenantsTable)
    .values({
      clerkUserId: `test_inv_clerk_${Date.now()}`,
      name: "test_invoice_tenant",
      email: "test-invoices@example.com",
    })
    .returning();
  tenantId = t.id;
});

afterAll(async () => {
  if (refIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.refId, refIds));
  }
  await db.delete(billingProfilesTable).where(eq(billingProfilesTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await pool.end();
});

describe("financialYearLabel", () => {
  it("uses the Indian April-March financial year", () => {
    expect(financialYearLabel(new Date("2026-08-12"))).toBe("2026-27");
    expect(financialYearLabel(new Date("2026-03-31"))).toBe("2025-26");
    expect(financialYearLabel(new Date("2026-04-01"))).toBe("2026-27");
  });
});

describe("recordInvoice", () => {
  it("creates a numbered invoice with seller and buyer snapshots", async () => {
    const refId = ref("create");
    const inv = await recordInvoice({
      tenantId,
      kind: "wallet_topup",
      refId,
      gateway: "razorpay",
      description: "Wallet top-up",
      baseAmountPaise: 10000,
      gstAmountPaise: 1800,
      gstPercent: 18,
      totalPaise: 11800,
    });
    expect(inv).not.toBeNull();
    const settings = await getInvoiceSettings();
    // Compact GST format, e.g. AE2627-000000001 (16 chars with 2-char prefix).
    expect(inv!.invoiceNumber).toMatch(
      new RegExp(`^${settings.numberPrefix}\\d{4}-\\d{9}$`),
    );
    expect(inv!.invoiceNumber.length).toBeLessThanOrEqual(16);
    expect(inv!.seller.legalName).toBe(settings.legalName);
    expect(inv!.buyer.legalName).toBe("test_invoice_tenant");
    expect(inv!.totalPaise).toBe(11800);
  });

  it("is idempotent on (kind, refId) and never re-numbers", async () => {
    const refId = ref("idem");
    const first = await recordInvoice({
      tenantId,
      kind: "credit_pack",
      refId,
      gateway: "cashfree",
      description: "Credit pack — Starter",
      baseAmountPaise: 49900,
      totalPaise: 49900,
    });
    const second = await recordInvoice({
      tenantId,
      kind: "credit_pack",
      refId,
      gateway: "cashfree",
      description: "Credit pack — Starter",
      baseAmountPaise: 49900,
      totalPaise: 49900,
    });
    expect(second!.id).toBe(first!.id);
    expect(second!.invoiceNumber).toBe(first!.invoiceNumber);
    const all = await db.select().from(invoicesTable).where(eq(invoicesTable.refId, refId));
    expect(all).toHaveLength(1);
  });

  it("assigns strictly increasing sequence numbers", async () => {
    const a = await recordInvoice({
      tenantId,
      kind: "plan",
      refId: ref("seq_a"),
      gateway: "razorpay",
      description: "Growth plan — monthly subscription",
      baseAmountPaise: 99900,
      totalPaise: 99900,
    });
    const b = await recordInvoice({
      tenantId,
      kind: "plan",
      refId: ref("seq_b"),
      gateway: "razorpay",
      description: "Growth plan — monthly subscription",
      baseAmountPaise: 99900,
      totalPaise: 99900,
    });
    const seq = (n: string) => Number(n.split("-")[1]);
    expect(seq(b!.invoiceNumber)).toBeGreaterThan(seq(a!.invoiceNumber));
  });

  it("issues exactly one invoice when concurrent calls race on the same refId", async () => {
    const refId = ref("race");
    const make = () =>
      recordInvoice({
        tenantId,
        kind: "plan",
        refId,
        gateway: "razorpay",
        description: "Growth plan — monthly subscription",
        baseAmountPaise: 99900,
        totalPaise: 99900,
      });
    const results = await Promise.all([make(), make(), make(), make()]);
    const ids = new Set(results.map((r) => r!.id));
    expect(ids.size).toBe(1);
    const rows = await db.select().from(invoicesTable).where(eq(invoicesTable.refId, refId));
    expect(rows).toHaveLength(1);
    // The loser must not have burned a sequence number: the next invoice
    // gets exactly seq+1.
    const next = await recordInvoice({
      tenantId,
      kind: "plan",
      refId: ref("race_next"),
      gateway: "razorpay",
      description: "Growth plan — monthly subscription",
      baseAmountPaise: 99900,
      totalPaise: 99900,
    });
    const seq = (n: string) => Number(n.split("-")[1]);
    expect(seq(next!.invoiceNumber)).toBe(seq(rows[0].invoiceNumber) + 1);
  });

  it("uses the tenant's billing profile as buyer when present", async () => {
    await db
      .insert(billingProfilesTable)
      .values({
        tenantId,
        businessName: "Test Buyer Pvt Ltd",
        gstin: "29ABCDE1234F1Z5",
        address: "1 Test Street",
      })
      .onConflictDoUpdate({
        target: billingProfilesTable.tenantId,
        set: { businessName: "Test Buyer Pvt Ltd", gstin: "29ABCDE1234F1Z5" },
      });
    const inv = await recordInvoice({
      tenantId,
      kind: "wallet_topup",
      refId: ref("buyer"),
      gateway: "cashfree",
      description: "Wallet top-up",
      baseAmountPaise: 5000,
      gstAmountPaise: 900,
      gstPercent: 18,
      totalPaise: 5900,
    });
    expect(inv!.buyer.legalName).toBe("Test Buyer Pvt Ltd");
    expect(inv!.buyer.gstin).toBe("29ABCDE1234F1Z5");
  });

  it("lists a tenant's invoices and scopes getInvoice by tenant", async () => {
    const rows = await listInvoices(tenantId);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const other = await getInvoice(tenantId + 999999, rows[0].id);
    expect(other).toBeNull();
  });

  it("renders a PDF for an invoice", async () => {
    const rows = await listInvoices(tenantId);
    const pdf = await renderInvoicePdf(rows[0]);
    expect(pdf.length).toBeGreaterThan(500);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
