import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ plan: "free", job: null as any }));
vi.mock("@workspace/db", () => ({
  tenantsTable: { id: "id", plan: "plan" },
  videoGenerationsTable: { id: "jobId", tenantId: "tenantId" },
  db: { select: (selection?: unknown) => ({
    from: () => ({ where: () => ({ limit: async () => selection ? [{ plan: state.plan }] : state.job ? [state.job] : [] }) }),
  }) },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock("./meterFunding", () => ({
  freezeMeterFunding: vi.fn(async () => ({ tenantId: 1, rail: "credits", mode: "enforce" })),
}));
import { assertFreeVideoProviderAllowed, enforceFreeVideoRoutes, isStockOnlyVideo } from "./freeVideoPolicy";

async function route(path: string, body: any = {}, method = "POST") {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  await enforceFreeVideoRoutes({ path, method, body, tenantId: 1 } as any, res as any, next);
  return { res, next };
}
beforeEach(() => { state.plan = "free"; state.job = null; });
describe("free video policy", () => {
  it("allows stock topic requests but rejects AI modes before funding", async () => {
    expect((await route("/ai/generate-video", { engine: "topic_to_video", visualsSource: "stock" })).next).toHaveBeenCalled();
    for (const body of [
      { engine: "text_to_video" }, { engine: "image_to_video" },
      { engine: "topic_to_video", visualsSource: "ai" },
      { engine: "topic_to_video", templateId: 1 },
      { engine: "topic_to_video", studioLipSync: { requested: true } },
      { engine: "topic_to_video", referenceImages: [{}] },
      { engine: "topic_to_video", suppliedPlan: {} },
    ]) expect((await route("/ai/generate-video", body)).res.status).toHaveBeenCalledWith(403);
  });
  it("leaves AI posts/images available while blocking provider video visuals", async () => {
    await expect(assertFreeVideoProviderAllowed(1, "image", "imageJob")).resolves.toBeUndefined();
    await expect(assertFreeVideoProviderAllowed(1, "caption", "videoJob")).resolves.toBeUndefined();
    await expect(assertFreeVideoProviderAllowed(1, "voice", "videoJob")).resolves.toBeUndefined();
    for (const key of ["video", "video_hd", "lipsync", "image", "image_edit"]) {
      await expect(assertFreeVideoProviderAllowed(1, key, "videoJob")).rejects.toMatchObject({ code: "FREE_PLAN_STOCK_VIDEO_ONLY" });
    }
    expect((await route("/ai/generate-image")).next).toHaveBeenCalled();
  });
  it("checks retries, drafts and covers, while allowing cancellation and extracted covers", async () => {
    for (const path of ["/ai/guided-story/drafts", "/ai/video-jobs/1/retry", "/ai/video-jobs/1/cover-candidates/generate"]) {
      expect((await route(path)).res.status).toHaveBeenCalledWith(403);
    }
    state.job = { engine: "topic_to_video", options: { freeStockVideo: true, visualsSource: "stock" } };
    expect((await route("/ai/video-jobs/1/retry")).next).toHaveBeenCalled();
    expect((await route("/ai/video-jobs/1/cancel")).next).toHaveBeenCalled();
    expect((await route("/ai/video-jobs/1/cover-candidates")).next).toHaveBeenCalled();
  });
  it("preserves paid plan options", async () => {
    state.plan = "pro";
    expect((await route("/ai/generate-video", { engine: "text_to_video" })).next).toHaveBeenCalled();
    await expect(assertFreeVideoProviderAllowed(1, "video", "videoJob")).resolves.toBeUndefined();
  });
  it("rejects hidden AI snapshot work", () => {
    expect(isStockOnlyVideo("topic_to_video", { visualsSource: "stock", studioLipSync: { requested: true } })).toBe(false);
    expect(isStockOnlyVideo("topic_to_video", { visualsSource: "stock", guidedStory: {} })).toBe(false);
  });
});