import { afterAll, expect, it } from "vitest";
import { db, videoGenerationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant, type TestTenant } from "../../test/dbHelpers";
import { setJob } from "./jobRunner";

const tenants: TestTenant[] = [];
afterAll(async () => {
  for (const tenant of tenants) await deleteTenant(tenant.tenantId);
});

it("limits worker updates to the selected unrejected job even when other tenants have JSON-null rejections", async () => {
  for (let i = 0; i < 2; i++) tenants.push(await createTenant({ plan: "pro" }));
  const [target, sameTenant, otherTenant, rejected] = await db.insert(videoGenerationsTable).values([
    { tenantId: tenants[0]!.tenantId, engine: "topic_to_video", status: "queued", options: { aspectRatio: "9:16" } },
    { tenantId: tenants[0]!.tenantId, engine: "topic_to_video", status: "queued", options: { aspectRatio: "9:16", storyboardRejection: null } },
    { tenantId: tenants[1]!.tenantId, engine: "topic_to_video", status: "queued", options: { aspectRatio: "9:16", storyboardRejection: null } },
    { tenantId: tenants[0]!.tenantId, engine: "topic_to_video", status: "failed", options: {
      aspectRatio: "9:16",
      storyboardRejection: {
        version: 1, rejectedAt: "2026-01-01T00:00:00.000Z",
        removedCharacterIds: [], preservedCharacterIds: [],
        cleanup: { state: "complete", assets: [], attempts: 0, nextAttemptAt: "2026-01-01T00:00:00.000Z", message: null },
      },
    } },
  ]).returning();
  await setJob(target!.id, { status: "running", stage: "test checkpoint" });
  const read = async (id: number) => (await db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, id)))[0]!;
  expect((await read(target!.id)).status).toBe("running");
  expect(await read(sameTenant!.id)).toEqual(sameTenant);
  expect(await read(otherTenant!.id)).toEqual(otherTenant);
  await setJob(rejected!.id, { status: "running" });
  expect(await read(rejected!.id)).toEqual(rejected);
  // JSON null remains eligible, but only when it is the explicitly named job.
  await setJob(sameTenant!.id, { status: "running" });
  expect((await read(sameTenant!.id)).status).toBe("running");
  expect(await read(otherTenant!.id)).toEqual(otherTenant);
});