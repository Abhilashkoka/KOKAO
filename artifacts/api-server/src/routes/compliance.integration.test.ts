import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () => authState.userId ? { userId: authState.userId, sessionClaims: { userId: authState.userId } } : {},
    clerkClient: { users: { getUser: async (id: string) => { const u = authState.users[id]; if (!u) throw new Error("user not found"); return u; } } },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});
const runnerState = vi.hoisted(() => ({ resumed: [] as number[] }));
vi.mock("../lib/videoGen/jobRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/videoGen/jobRunner")>()),
  runVideoGenerationJob: vi.fn(async () => undefined),
  resumeVideoGenerationJob: vi.fn(async (job: { id: number }) => { runnerState.resumed.push(job.id); }),
}));
const serviceState = vi.hoisted(() => ({ failLoads: false }));
vi.mock("../lib/brandKit/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/brandKit/service")>();
  return { ...actual, loadActivePayload: vi.fn(async (...args: Parameters<typeof actual.loadActivePayload>) => {
    if (serviceState.failLoads) throw new Error("db unavailable (simulated)");
    return actual.loadActivePayload(...args);
  }) };
});
import request from "supertest";
import express from "express";
import { and, eq } from "drizzle-orm";
import { db, contentItemsTable, scheduledPostsTable, tenantsTable, videoGenerationsTable,
  type BrandKitPayload, type FrozenJobCompliance, type VideoStoryboard } from "@workspace/db";
import { requireTenant } from "../middlewares/requireTenant";
import { complianceErrorHandler } from "../middlewares/complianceErrors";
import videosRouter from "./videos";
import complianceRouter from "./compliance";
import schedulesRouter from "./schedules";
import { publishLinkedinCore } from "./linkedin";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { waitForPendingJobs } from "../lib/backgroundJobs";
import { createKit } from "../lib/brandKit/service";
import { buildDefaultPayload } from "../lib/brandKit/defaults";
import { resolveJobCompliance, setSemanticReviewer, storyboardComplianceError, storyboardComplianceReport, type SemanticReviewer } from "../lib/compliance";
const api = express();
api.use(express.json());
api.use((req, _res, next) => {
  (req as unknown as { log: Record<string, () => void> }).log = { info() {}, error() {}, warn() {}, debug() {} };
  next();
});
api.use("/api", requireTenant, complianceRouter, videosRouter, schedulesRouter);
api.use("/api", complianceErrorHandler);
const tenants: TestTenant[] = [];
const reviewer = vi.hoisted(() => ({ calls: 0, mode: "clean" as "clean" | "block-paraphrase" | "down" }));
const fakeReviewer: SemanticReviewer = async ({ items, compliance }) => {
  reviewer.calls += 1;
  if (reviewer.mode === "down") {
    const { ComplianceUnavailableError } = await import("../lib/compliance/errors");
    throw new ComplianceUnavailableError();
  }
  const findings = reviewer.mode === "block-paraphrase"
    ? items.filter((i) => /vanish for good/i.test(i.text)).map((i) => ({
      ruleId: "nmc.guarantee", title: compliance.pack.rules[0]!.title, severity: "block" as const,
      source: "AI review", field: i.field, location: i.location, match: "vanish for good", excerpt: "permanent result",
    })) : [];
  return { findings, model: "fake-reviewer", reviewedAt: new Date().toISOString() };
};
async function regulatedTenant(industry = "Dermatologist") {
  const t = await createTenant({ plan: "pro" });
  await db.update(tenantsTable).set({ industry }).where(eq(tenantsTable.id, t.tenantId));
  tenants.push(t); actAs(t.clerkUserId); return t;
}
function board(text: string, visual = "doctor explaining at a desk"): VideoStoryboard {
  return { version: 1, visualsSource: "character", timelineLocked: true, model: null, provider: null, regenerations: 0,
    narration: { audioPath: "/objects/1/uploads/narration.wav", totalDurationSec: 6, cues: [{ text, startSec: 0, endSec: 6 }] },
    scenes: [{ id: "s1", text, visual, durationSec: 6, previewPath: null, outfitId: null }] };
}
async function seedPausedJob(tenantId: number, storyboard: VideoStoryboard, compliance: FrozenJobCompliance | null) {
  return (await db.insert(videoGenerationsTable).values({
    tenantId, engine: "topic_to_video", status: "awaiting_review", funding: "quota",
    options: { aspectRatio: "9:16", visualsSource: "character", paragraphCount: 1, compliance },
    storyboard, storyboardExpiresAt: new Date(Date.now() + 600_000),
  }).returning())[0]!;
}
async function readJob(id: number) {
  return (await db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, id)).limit(1))[0]!;
}
beforeEach(() => {
  resetAuthState(); runnerState.resumed.length = 0; serviceState.failLoads = false;
  reviewer.calls = 0; reviewer.mode = "clean"; setSemanticReviewer(fakeReviewer);
});
afterAll(async () => {
  setSemanticReviewer(null);
  await waitForPendingJobs().catch(() => undefined);
  for (const t of tenants) await deleteTenant(t.tenantId).catch(() => undefined);
});
describe("storyboard review → render journey", () => {
  it("blocks, checks edits, runs AI review, binds approval and gates rendering", async () => {
    const t = await regulatedTenant(), frozen = (await resolveJobCompliance(t.tenantId, null))!;
    expect(frozen).toMatchObject({ profession: "medical", packVersion: "2026.10.2" });
    frozen.semanticReviewRequired = true;
    const job = await seedPausedJob(t.tenantId, board("We guarantee clear skin in 30 days."), frozen);
    const read = await request(api).get(`/api/ai/video-jobs/${job.id}`);
    expect(read.status).toBe(200); expect(read.body.compliance.report.blocking).toBeGreaterThan(0);
    const blocked = await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({});
    expect(blocked.status).toBe(400); expect(blocked.body.code).toBe("compliance_blocked"); expect(reviewer.calls).toBe(0);
    const worse = await request(api).patch(`/api/ai/video-jobs/${job.id}/storyboard`).send({ scenes: [{ id: "s1", text: "We guarantee clear skin. Flat 20% off today!" }] });
    expect(worse.status, JSON.stringify(worse.body)).toBe(400); expect(worse.body.code).toBe("compliance_blocked");
    const fixed = await request(api).patch(`/api/ai/video-jobs/${job.id}/storyboard`).send({ scenes: [{ id: "s1", text: "Over 500 patients asked us about acne. Results vary." }] });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const needsAck = await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({});
    expect(needsAck.status).toBe(400); expect(needsAck.body.code).toBe("compliance_review_required"); expect(reviewer.calls).toBe(1);
    let row = await readJob(job.id);
    expect(row.options?.compliance?.semanticReview?.model).toBe("fake-reviewer"); expect(row.status).toBe("awaiting_review");
    const approved = await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({ acknowledgeComplianceReview: true });
    expect(approved.status, JSON.stringify(approved.body)).toBe(202); expect(reviewer.calls).toBe(1);
    await waitForPendingJobs(); expect(runnerState.resumed).toContain(job.id);
    row = await readJob(job.id);
    expect(row.options?.compliance?.reviewAcknowledgedBy).toBe(t.clerkUserId);
    expect(row.options?.compliance?.reviewAcknowledgedContentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(storyboardComplianceError(row.storyboard, row.options!.compliance, { requireReviewAck: true })).toBeNull();
    const changed = board("Over 500 patients asked us about acne. Results vary. Visit us.");
    expect(storyboardComplianceError(changed, row.options!.compliance, { requireReviewAck: true })?.code).toBe("compliance_ai_review_required");
    const reReviewed = { ...row.options!.compliance!, semanticReview: { ...row.options!.compliance!.semanticReview!,
      contentFingerprint: storyboardComplianceReport(changed, row.options!.compliance)!.contentFingerprint! } };
    expect(storyboardComplianceError(changed, reReviewed, { requireReviewAck: true })?.code).toBe("compliance_review_required");
  });
  it("blocks paraphrases flagged by AI", async () => {
    const t = await regulatedTenant(), frozen = (await resolveJobCompliance(t.tenantId, null))!;
    frozen.semanticReviewRequired = true;
    const job = await seedPausedJob(t.tenantId, board("Your acne will vanish for good after one visit."), frozen);
    reviewer.mode = "block-paraphrase";
    const res = await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({ acknowledgeComplianceReview: true });
    expect(res.status).toBe(400); expect(res.body.code).toBe("compliance_blocked");
    expect(res.body.compliance.findings.some((f: { source: string }) => f.source.startsWith("AI review"))).toBe(true);
    expect(runnerState.resumed).toHaveLength(0);
  });
  it("stops on AI outage", async () => {
    const t = await regulatedTenant(), frozen = (await resolveJobCompliance(t.tenantId, null))!;
    frozen.semanticReviewRequired = true;
    const job = await seedPausedJob(t.tenantId, board("Acne has many causes."), frozen);
    reviewer.mode = "down";
    const res = await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({});
    expect(res.status).toBe(503); expect(res.body.code).toBe("compliance_unavailable");
    expect((await readJob(job.id)).status).toBe("awaiting_review"); expect(runnerState.resumed).toHaveLength(0);
  });
  it("refuses unknown rules but list loads", async () => {
    const t = await regulatedTenant(), frozen = { ...(await resolveJobCompliance(t.tenantId, null))!, packVersion: "1999.01.1" };
    const job = await seedPausedJob(t.tenantId, board("Acne explained."), frozen);
    const res = await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({});
    expect(res.status).toBe(409); expect(res.body.code).toBe("compliance_config");
    const read = await request(api).get(`/api/ai/video-jobs/${job.id}`);
    expect(read.status).toBe(200); expect(read.body.compliance.report).toBeNull();
  });
});
describe("retry", () => {
  it("re-reviews edited plans and stores acknowledgement", async () => {
    const t = await regulatedTenant(), frozen = (await resolveJobCompliance(t.tenantId, null))!;
    const job = await seedPausedJob(t.tenantId, board("Over 500 patients asked about acne."), frozen);
    await db.update(videoGenerationsTable).set({ status: "failed", error: "provider failed" }).where(eq(videoGenerationsTable.id, job.id));
    const blocked = await request(api).post(`/api/ai/video-jobs/${job.id}/retry`).send({});
    expect(blocked.status).toBe(400); expect(blocked.body.code).toBe("compliance_review_required");
    const acked = await request(api).post(`/api/ai/video-jobs/${job.id}/retry`).send({ acknowledgeComplianceReview: true });
    expect(String(acked.body.code ?? "")).not.toMatch(/^compliance_/);
    expect((await readJob(job.id)).options?.compliance?.reviewAcknowledgedContentFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
describe("fail closed", () => {
  it("throws on lookup error", async () => {
    const t = await regulatedTenant(); serviceState.failLoads = true;
    await expect(resolveJobCompliance(t.tenantId, 123456)).rejects.toMatchObject({ code: "compliance_unavailable" });
  });
  it("test endpoint never returns clean for lookup error", async () => {
    const t = await regulatedTenant();
    const kit = await createKit({ tenantId: t.tenantId, plan: "pro", name: "Clinic", createdBy: t.clerkUserId,
      payload: buildDefaultPayload({ brandName: "Clinic", industry: "Doctor" }) });
    serviceState.failLoads = true;
    const res = await request(api).post("/api/brand-kits/compliance/check").send({ text: "We guarantee results", brandKitId: (kit as { id: number }).id });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
describe("cross-account isolation", () => {
  it("foreign kit cannot leak facts", async () => {
    const a = await regulatedTenant("Doctor");
    const payload = buildDefaultPayload({ brandName: "Clinic", industry: "Doctor" }) as BrandKitPayload;
    payload.compliance = { profession: "medical", source: "manual", confirmed_at: new Date().toISOString(),
      facts: { practitioner_name: "Dr test", registration_number: "SECRET-A-123", registering_body: "TSMC",
        qualifications: ["MBBS"], services: [], practice_address: "", verified_claims: [] }, extra_negative_terms: [] };
    const kit = await createKit({ tenantId: a.tenantId, plan: "pro", name: "Clinic", createdBy: a.clerkUserId, payload });
    const aKit = (kit as { id: number }).id, b = await regulatedTenant("Bakery");
    expect((await request(api).post("/api/brand-kits/compliance/check").send({ text: "hello", brandKitId: aKit })).status).toBe(404);
    expect(await resolveJobCompliance(b.tenantId, aKit)).toBeNull();
    const c = await regulatedTenant("Doctor"), frozen = await resolveJobCompliance(c.tenantId, aKit);
    expect(frozen?.profession).toBe("medical"); expect(frozen?.brandKitId).toBeNull();
    expect(JSON.stringify(frozen)).not.toContain("SECRET-A-123");
  });
  it("foreign job cannot be read or approved", async () => {
    const a = await regulatedTenant(), job = await seedPausedJob(a.tenantId, board("Acne explained."), await resolveJobCompliance(a.tenantId, null));
    await regulatedTenant();
    expect((await request(api).get(`/api/ai/video-jobs/${job.id}`)).status).toBe(404);
    expect([400, 404]).toContain((await request(api).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`).send({ acknowledgeComplianceReview: true })).status);
    expect((await readJob(job.id)).status).toBe("awaiting_review");
    expect((await readJob(job.id)).options?.compliance?.reviewAcknowledgedBy ?? null).toBeNull();
  });
});
describe("scheduling and publishing", () => {
  async function post(tenantId: number, caption: string) {
    return (await db.insert(contentItemsTable).values({ tenantId, title: "Acne tips", caption, platform: "linkedin" }).returning())[0]!;
  }
  it("refuses blocked posts before platform calls", async () => {
    const t = await regulatedTenant(), bad = await post(t.tenantId, "Guaranteed clear skin — best dermatologist in Hyderabad!");
    const res = await request(api).post("/api/schedules").send({ contentItemId: bad.id, platform: "linkedin", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.status).toBe(422); expect(res.body.code).toBe("compliance_blocked");
    expect(await db.select().from(scheduledPostsTable).where(and(eq(scheduledPostsTable.tenantId, t.tenantId), eq(scheduledPostsTable.contentItemId, bad.id)))).toHaveLength(0);
    expect(await publishLinkedinCore(t.tenantId, bad.id)).toMatchObject({ ok: false, errorStatus: 422 });
  });
  it("allows compliant posts and retries unavailable checks", async () => {
    const t = await regulatedTenant(), ok = await post(t.tenantId, "Acne has many causes. See a dermatologist if it persists.");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request(api).post("/api/schedules").send({ contentItemId: ok.id, platform: "linkedin", scheduledAt: at });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    reviewer.mode = "down";
    const later = await post(t.tenantId, "Sunscreen every day helps.");
    const down = await request(api).post("/api/schedules").send({ contentItemId: later.id, platform: "linkedin", scheduledAt: at });
    expect(down.status).toBe(503);
    expect(await publishLinkedinCore(t.tenantId, later.id)).toMatchObject({ ok: false, errorStatus: 503 });
  });
  it("does not constrain unregulated workspaces", async () => {
    const t = await regulatedTenant("Bakery"), p = await post(t.tenantId, "Guaranteed best cakes in town, 20% off!");
    const res = await request(api).post("/api/schedules").send({ contentItemId: p.id, platform: "linkedin", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.status).toBe(201); expect(reviewer.calls).toBe(0);
  });
});