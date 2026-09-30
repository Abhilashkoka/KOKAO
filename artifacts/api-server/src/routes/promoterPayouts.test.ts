import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  featureOff: false,
  creator: { id: 7, status: "approved" },
  identity: { panLast4: "1234", bankLast4: "4567", ifsc: "ABCD0123456", beneficiaryName: "A User", verifiedAt: null, panHash: "PRIVATE_PAN_HASH", bankAccountHash: "PRIVATE_BANK_HASH" },
  payouts: [{ id: 9, grossPaise: 12500, tdsPaise: 250, tdsRateBps: 200, reserveHeldPaise: 1250, netPaise: 11000, status: "paid", reserveReleasedAt: null, paidAt: null, gatewayRef: "ABC", panHash: "PRIVATE_PAN_HASH" }],
  save: vi.fn(), paid: vi.fn(), audit: vi.fn(),
}));
vi.mock("../lib/featureFlags", () => ({
  requireFeature: () => (_req: unknown, res: { status: (n: number) => { json: (v: unknown) => void } }, next: () => void) =>
    mocks.featureOff ? res.status(403).json({ error: "Feature disabled", code: "feature_disabled" }) : next(),
}));
vi.mock("../middlewares/requireSuperadmin", () => ({
  requireSuperadmin: (req: { headers: Record<string, string> }, res: { status: (n: number) => { json: (v: unknown) => void } }, next: () => void) =>
    req.headers["x-test-admin"] === "yes" ? next() : res.status(403).json({ error: "Forbidden" }),
}));
vi.mock("../lib/creatorProgram", () => ({ getCreatorForTenant: async () => mocks.creator }));
vi.mock("../lib/adminAudit", () => ({ recordAdminAction: mocks.audit }));
vi.mock("../lib/creatorPayouts", () => ({
  PayoutIdentityError: class PayoutIdentityError extends Error { constructor(message: string, public code: string) { super(message); } },
  getCreatorPayoutIdentity: async () => mocks.identity,
  getPayoutBalance: async () => ({ payablePaise: 12500, netOwedPaise: 12500, owedBackPaise: 0 }),
  listCreatorPayouts: async () => mocks.payouts,
  saveCreatorPayoutIdentity: mocks.save,
  markPayoutPaid: mocks.paid,
  buildPayoutRun: vi.fn(),
  exportPayoutBatch: vi.fn(),
  markPayoutFailed: vi.fn(),
  clawbackPaidCommission: vi.fn(),
  releaseMatureReserves: vi.fn(),
}));
import router from "./promoterPayouts";
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { tenantId: number; log: { error: () => void } }).tenantId = 42;
  (req as unknown as { log: { error: () => void } }).log = { error() {} };
  next();
});
app.use(router);
app.get("/admin/other-module", (_req, res) => res.json({ ok: true }));
beforeEach(() => {
  mocks.featureOff = false;
  mocks.creator.status = "approved";
  mocks.save.mockReset().mockResolvedValue(mocks.identity);
  mocks.paid.mockReset().mockResolvedValue(null);
  mocks.audit.mockReset().mockResolvedValue(undefined);
});
describe("promoter payout routes", () => {
  it("returns only masked identity and a scoped payout history, never hashes", async () => {
    const details = await request(app).get("/promoter/payout-details");
    const history = await request(app).get("/promoter/payouts");
    expect(details.status).toBe(200);
    expect(history.status).toBe(200);
    expect(JSON.stringify([details.body, history.body])).not.toMatch(/PRIVATE_|panHash|bankAccountHash|accountNumber/);
    expect(details.body).toEqual({ onFile: true, panLast4: "1234", bankLast4: "4567", ifsc: "ABCD0123456", beneficiaryName: "A User", verified: false });
    expect(history.body.payouts[0]).toMatchObject({ gross: 125, tds: 2.5, reserveHeld: 12.5, net: 110 });
  });
  it("requires approved status and rejects unexpected sensitive keys", async () => {
    mocks.creator.status = "suspended";
    expect((await request(app).post("/promoter/payout-details").send({})).status).toBe(403);
    mocks.creator.status = "approved";
    const invalid = await request(app).post("/promoter/payout-details").send({
      pan: "ABCDE1234F", accountNumber: "123456", ifsc: "ABCD0123456", beneficiaryName: "A User", unknown: "secret",
    });
    expect(invalid.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("fails closed when the privacy key is missing without echoing sensitive input", async () => {
    const { PayoutIdentityError } = await import("../lib/creatorPayouts");
    mocks.save.mockRejectedValueOnce(new PayoutIdentityError("Payout identity collection is unavailable.", "pii_not_configured"));
    const result = await request(app).post("/promoter/payout-details").send({
      pan: "ABCDE1234F", accountNumber: "1234567890", ifsc: "ABCD0123456", beneficiaryName: "A User",
    });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("pii_not_configured");
    expect(JSON.stringify(result.body)).not.toMatch(/ABCDE1234F|1234567890|PRIVATE_/);
  });
  it("keeps admin path authorization exact and checks the feature switch", async () => {
    expect((await request(app).post("/admin/payouts/run")).status).toBe(403);
    expect((await request(app).get("/admin/other-module")).status).toBe(200);
    mocks.featureOff = true;
    expect((await request(app).get("/promoter/payouts")).status).toBe(403);
    expect((await request(app).get("/promoter/payout-details")).status).toBe(403);
    expect((await request(app).get("/admin/other-module")).status).toBe(200);
  });
  it("requires a manual transfer reference and returns a state conflict", async () => {
    const path = "/admin/payouts/9/paid";
    expect((await request(app).post(path).set("x-test-admin", "yes").send({})).status).toBe(400);
    const result = await request(app).post(path).set("x-test-admin", "yes").send({ reference: "BANK-TXN-001" });
    expect(result.status).toBe(409);
    expect(mocks.paid).toHaveBeenCalledWith(9, "BANK-TXN-001");
  });
});