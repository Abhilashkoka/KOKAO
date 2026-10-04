import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, charactersTable, characterOutfitsTable, videoGenerationsTable, guidedStoryDraftsTable, type GuidedStoryDraftState } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant, type TestTenant } from "../../test/dbHelpers";

const provider = vi.hoisted(() => ({
  deletes: [] as number[], existing: new Set<number>(), terminal: true,
  failDelete: false, failGet: false, noKey: false, afterDeleteStillPresent: false,
}));
vi.mock("../atlascloud/assets", () => ({
  resolveAtlasAssetsKey: async () => provider.noKey ? null : "test-key",
  getAtlasAsset: async (id: number) => {
    if (provider.failGet) throw new Error("provider GET down");
    if (!provider.existing.has(id)) throw Object.assign(new Error("absent"), { status: 404 });
    return { libraryRecordId: id, status: "Active" };
  },
  deleteAtlasAsset: async (id: number) => {
    provider.deletes.push(id);
    if (provider.failDelete) throw new Error("provider DELETE down");
    if (!provider.afterDeleteStillPresent) provider.existing.delete(id);
  },
  isAtlasPredictionTerminal: async () => provider.terminal,
}));
vi.mock("../byteplus/assets", () => ({
  resolveBytePlusAssetsCredentials: async () => null,
  deleteAsset: vi.fn(),
}));
import { cleanupRejectedStoryboard, referencedCharacterIds, rejectStoryboard } from "./storyboardRejection";

const tenants: TestTenant[] = [];
async function tenant() { const t = await createTenant({ plan: "pro" }); tenants.push(t); return t.tenantId; }
async function character(tenantId: number, atlasId: number | null = null) {
  const [row] = await db.insert(charactersTable).values({
    tenantId, name: "Disposable rejection fixture", description: "fictional",
    referenceImagePath: `/objects/${tenantId}/uploads/fake`, atlasAssetLibraryId: atlasId,
  }).returning();
  if (atlasId) provider.existing.add(atlasId);
  return row!;
}
async function video(tenantId: number, characterId: number, extra: Partial<typeof videoGenerationsTable.$inferInsert> = {}) {
  const [row] = await db.insert(videoGenerationsTable).values({
    tenantId, engine: "topic_to_video", status: "failed",
    options: { aspectRatio: "9:16", characterId }, ...extra,
  }).returning();
  return row!;
}
async function read(id: number) {
  return (await db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, id)))[0]!;
}
async function due(id: number) {
  const job = await read(id);
  const rejection = job.options!.storyboardRejection!;
  await db.update(videoGenerationsTable).set({ options: {
    ...job.options!, storyboardRejection: { ...rejection, cleanup: {
      ...rejection.cleanup, nextAttemptAt: new Date(0).toISOString(), leaseExpiresAt: null,
    } },
  } }).where(eq(videoGenerationsTable.id, id));
}
function draftState(characterId: number, storyboardJobId: number | null = null): GuidedStoryDraftState {
  return {
    version: 1, setup: null, script: null, scriptApprovedAt: null, userRoleId: null, castStrategy: "saved",
    cast: [{ characterId }], duplicateAssignmentConfirmed: false, scriptGeneration: null,
    castOperations: {}, storyboardJobId,
  } as unknown as GuidedStoryDraftState;
}
beforeEach(() => {
  provider.deletes = []; provider.existing = new Set(); provider.terminal = true;
  provider.failDelete = provider.failGet = provider.noKey = provider.afterDeleteStillPresent = false;
});
afterAll(async () => {
  for (const t of tenants) {
    await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, t.tenantId));
    await db.delete(guidedStoryDraftsTable).where(eq(guidedStoryDraftsTable.tenantId, t.tenantId));
    await db.delete(characterOutfitsTable).where(eq(characterOutfitsTable.tenantId, t.tenantId));
    await db.delete(charactersTable).where(eq(charactersTable.tenantId, t.tenantId));
    await deleteTenant(t.tenantId);
  }
});

describe("reject storyboard: local removal and durable cleanup", () => {
  it.each(["failed", "succeeded"])("removes unused library characters and outfits for a %s video without provider calls", async (status) => {
    const tid = await tenant(), c = await character(tid, 70001), job = await video(tid, c.id, { status });
    await db.insert(characterOutfitsTable).values({
      tenantId: tid, characterId: c.id, name: "Test outfit", description: "suit",
      referenceImagePath: "/objects/test/outfit", atlasAssetLibraryId: 70002,
    });
    provider.existing.add(70002);
    const rejected = await rejectStoryboard(tid, job.id);
    expect(rejected.status).toBe(status);
    expect(rejected.options?.storyboardRejection?.removedCharacterIds).toEqual([c.id]);
    expect(rejected.options?.storyboardRejection?.cleanup.assets).toHaveLength(2);
    expect(await db.select().from(charactersTable).where(eq(charactersTable.id, c.id))).toHaveLength(0);
    expect(await db.select().from(characterOutfitsTable).where(eq(characterOutfitsTable.characterId, c.id))).toHaveLength(0);
    expect(provider.deletes).toEqual([]);
    await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([70001, 70002]);
    expect((await read(job.id)).options?.storyboardRejection?.cleanup.state).toBe("complete");
  });
  it("preserves characters used by another job, including completed history", async () => {
    const tid = await tenant(), shared = await character(tid, 70003), job = await video(tid, shared.id);
    await video(tid, shared.id, { status: "succeeded" });
    const result = await rejectStoryboard(tid, job.id);
    expect(result.options?.storyboardRejection?.preservedCharacterIds).toEqual([shared.id]);
    expect(result.options?.storyboardRejection?.removedCharacterIds).toEqual([]);
    await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([]);
  });
  it("preserves characters selected in another draft", async () => {
    const tid = await tenant(), c = await character(tid), job = await video(tid, c.id);
    await db.insert(guidedStoryDraftsTable).values({ tenantId: tid, state: draftState(c.id) });
    expect((await rejectStoryboard(tid, job.id)).options?.storyboardRejection?.preservedCharacterIds).toEqual([c.id]);
  });
  it("clears only this job's current draft cast and approvals", async () => {
    const tid = await tenant(), c = await character(tid), job = await video(tid, c.id);
    const [draft] = await db.insert(guidedStoryDraftsTable).values({ tenantId: tid, state: draftState(c.id, job.id) }).returning();
    await db.update(videoGenerationsTable).set({ options: {
      ...job.options!, guidedStory: { draftId: draft!.id, cast: [{ characterId: c.id }] } as any,
    } }).where(eq(videoGenerationsTable.id, job.id));
    const result = await rejectStoryboard(tid, job.id);
    expect(result.options?.storyboardRejection?.removedCharacterIds).toEqual([c.id]);
    const [saved] = await db.select().from(guidedStoryDraftsTable).where(eq(guidedStoryDraftsTable.id, draft!.id));
    expect(saved?.state.cast).toEqual([]);
    expect(saved?.state.storyboardJobId).toBeNull();
    expect(saved?.revision).toBe(2);
  });
  it("protects other tenants and active jobs", async () => {
    const tid = await tenant(), other = await tenant(), c = await character(tid), job = await video(tid, c.id);
    await expect(rejectStoryboard(other, job.id)).rejects.toMatchObject({ status: 404 });
    const running = await video(tid, c.id, { status: "processing" });
    await expect(rejectStoryboard(tid, running.id)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(charactersTable).where(eq(charactersTable.id, c.id))).toHaveLength(1);
  });
  it("deduplicates concurrent rejection clicks", async () => {
    const tid = await tenant(), c = await character(tid, 70004), job = await video(tid, c.id);
    const results = await Promise.all([rejectStoryboard(tid, job.id), rejectStoryboard(tid, job.id)]);
    expect(results[0].options?.storyboardRejection).toEqual(results[1].options?.storyboardRejection);
    await Promise.all([cleanupRejectedStoryboard(job.id), cleanupRejectedStoryboard(job.id)]);
    expect(provider.deletes).toEqual([70004]);
  });
  it("retains cleanup handles and retries after a DELETE outage", async () => {
    const tid = await tenant(), c = await character(tid, 70005), job = await video(tid, c.id);
    await rejectStoryboard(tid, job.id);
    provider.failDelete = true;
    await cleanupRejectedStoryboard(job.id);
    expect((await read(job.id)).options?.storyboardRejection?.cleanup.state).toBe("pending");
    expect(await db.select().from(charactersTable).where(eq(charactersTable.id, c.id))).toHaveLength(0);
    provider.failDelete = false; await due(job.id); await cleanupRejectedStoryboard(job.id);
    expect((await read(job.id)).options?.storyboardRejection?.cleanup.state).toBe("complete");
  });
  it("does not confuse DELETE success with verified absence", async () => {
    const tid = await tenant(), c = await character(tid, 70006), job = await video(tid, c.id);
    await rejectStoryboard(tid, job.id);
    provider.afterDeleteStillPresent = true;
    await cleanupRejectedStoryboard(job.id);
    expect((await read(job.id)).options?.storyboardRejection?.cleanup.state).toBe("pending");
  });
  it("GET outage or missing credentials never triggers blind deletion", async () => {
    const tid = await tenant(), c = await character(tid, 70007), job = await video(tid, c.id);
    await rejectStoryboard(tid, job.id);
    provider.failGet = true;
    await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([]);
    provider.failGet = false; provider.noKey = true; await due(job.id); await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([]);
    expect((await read(job.id)).options?.storyboardRejection?.cleanup.state).toBe("pending");
  });
  it("waits until accepted Atlas tasks are terminal", async () => {
    const tid = await tenant(), c = await character(tid, 70008), job = await video(tid, c.id, {
      options: { aspectRatio: "9:16", characterId: c.id, providerTasks: {
        scene: { provider: "atlascloud", model: "seedance", taskId: "task-1", requestId: null, acceptedAt: new Date().toISOString() },
      } },
    });
    await rejectStoryboard(tid, job.id); provider.terminal = false; await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([]);
    provider.terminal = true; await due(job.id); await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([70008]);
  });
  it("retains ambiguous registration handles instead of guessing an Atlas id", async () => {
    const tid = await tenant(), c = await character(tid), job = await video(tid, c.id);
    await db.update(charactersTable).set({ atlasAssetId: "legacy-unknown", atlasAssetSubmitFencedAt: new Date() }).where(eq(charactersTable.id, c.id));
    await rejectStoryboard(tid, job.id); await cleanupRejectedStoryboard(job.id);
    const cleanup = (await read(job.id)).options?.storyboardRejection?.cleanup;
    expect(cleanup?.state).toBe("pending");
    expect(cleanup?.assets[0].assetId).toBe("legacy-unknown");
    expect(provider.deletes).toEqual([]);
  });
  it("keeps legacy failed Atlas attempts without receipts pending", async () => {
    const tid = await tenant(), c = await character(tid, 70008), job = await video(tid, c.id, { provider: "atlascloud" });
    await rejectStoryboard(tid, job.id);
    await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([]);
    expect((await read(job.id)).options?.storyboardRejection?.cleanup.state).toBe("pending");
  });
  it("does not delete a provider handle still owned by a remaining character", async () => {
    const tid = await tenant(), c = await character(tid, 70009), job = await video(tid, c.id);
    await character(tid, 70009);
    await rejectStoryboard(tid, job.id); await cleanupRejectedStoryboard(job.id);
    expect(provider.deletes).toEqual([]);
  });
  it("keeps a live registration's local owner for its finalizer", async () => {
    const tid = await tenant(), c = await character(tid), job = await video(tid, c.id);
    await db.update(charactersTable).set({ atlasAssetLeaseOwner: "live-worker" }).where(eq(charactersTable.id, c.id));
    const rejected = await rejectStoryboard(tid, job.id);
    expect(rejected.options?.storyboardRejection?.preservedCharacterIds).toEqual([c.id]);
  });
  it("does not infer character references from unrelated record ids", () => {
    expect([...referencedCharacterIds({ id: 99, characterId: 1, cast: [{ characterId: 2 }], character: { id: 3 }, storyboardRejection: { characterId: 4 } })]).toEqual([1, 2, 3]);
  });
});