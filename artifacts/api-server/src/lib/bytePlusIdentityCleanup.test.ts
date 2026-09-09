import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, bytePlusIdentityCleanupsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  deleteAssetGroup: vi.fn(),
  resolveLivenessAssetGroup: vi.fn(),
}));

vi.mock("./byteplus/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./byteplus/assets")>();
  return {
    ...actual,
    resolveBytePlusAssetsCredentials: vi.fn(async () => ({
      accessKeyId: "test",
      secretAccessKey: "test",
      region: "test",
      service: "ark",
    })),
    resolveLivenessAssetGroup: mocks.resolveLivenessAssetGroup,
    deleteAssetGroup: mocks.deleteAssetGroup,
  };
});

import { BytePlusAssetsError } from "./byteplus/assets";
import {
  enqueueBytePlusIdentityCleanup,
  sweepBytePlusIdentityCleanups,
} from "./bytePlusIdentityCleanup";
import { encryptJson } from "./secretCrypto";

const tenantId = 91_158;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = "cleanup-test-session-secret";
  mocks.resolveLivenessAssetGroup.mockResolvedValue("resolved-group");
  await db.delete(bytePlusIdentityCleanupsTable)
    .where(eq(bytePlusIdentityCleanupsTable.tenantId, tenantId));
});

afterAll(async () => {
  await db.delete(bytePlusIdentityCleanupsTable)
    .where(eq(bytePlusIdentityCleanupsTable.tenantId, tenantId));
  await pool.end();
});

describe("BytePlus identity cleanup outbox", () => {
  it("retries transient outages without losing the provider asset reference", async () => {
    mocks.deleteAssetGroup.mockRejectedValueOnce(new BytePlusAssetsError("down", 503));
    const id = await enqueueBytePlusIdentityCleanup({
      tenantId,
      sourceIdentityId: 1,
      sourceAttemptId: "attempt-1",
      assetGroupId: "cleanup-transient",
    });

    expect(await sweepBytePlusIdentityCleanups({ tenantId })).toBe(1);

    const [row] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, id));
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      assetGroupId: "cleanup-transient",
      lastErrorCode: "http_503",
    });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks successful and already-deleted cleanup as complete", async () => {
    const successId = await enqueueBytePlusIdentityCleanup({
      tenantId,
      sourceIdentityId: 2,
      sourceAttemptId: "attempt-2",
      assetGroupId: "cleanup-success",
    });
    mocks.deleteAssetGroup.mockResolvedValueOnce(undefined);
    await sweepBytePlusIdentityCleanups({ tenantId });
    const [success] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, successId));
    expect(success).toMatchObject({ status: "succeeded", attempts: 1 });

    const missingId = await enqueueBytePlusIdentityCleanup({
      tenantId,
      sourceIdentityId: 3,
      sourceAttemptId: "attempt-3",
      assetGroupId: "cleanup-missing",
    });
    mocks.deleteAssetGroup.mockRejectedValueOnce(new BytePlusAssetsError("gone", 404));
    await sweepBytePlusIdentityCleanups({ tenantId });
    const [missing] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, missingId));
    expect(missing).toMatchObject({
      status: "succeeded",
      lastErrorCode: "already_deleted",
    });
  });

  it("terminates permanently unsupported deletion requests", async () => {
    const id = await enqueueBytePlusIdentityCleanup({
      tenantId,
      sourceIdentityId: 4,
      sourceAttemptId: "attempt-4",
      assetGroupId: "cleanup-unsupported",
    });
    mocks.deleteAssetGroup.mockRejectedValueOnce(
      new BytePlusAssetsError("unsupported", 400, "UnsupportedAction"),
    );

    await sweepBytePlusIdentityCleanups({ tenantId });

    const [row] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, id));
    expect(row).toMatchObject({
      status: "unsupported",
      attempts: 1,
      lastErrorCode: "UnsupportedAction",
    });
    expect(row!.completedAt).not.toBeNull();
  });

  it("resolves an in-flight verification token before deleting its asset group", async () => {
    const [queued] = await db.insert(bytePlusIdentityCleanupsTable).values({
      tenantId,
      sourceIdentityId: 5,
      sourceAttemptId: "attempt-5",
      verificationTokenEncrypted: encryptJson({ token: "callback-token" }),
    }).returning();
    mocks.deleteAssetGroup.mockResolvedValueOnce(undefined);

    await sweepBytePlusIdentityCleanups({ tenantId });

    expect(mocks.resolveLivenessAssetGroup).toHaveBeenCalledWith(
      "callback-token",
      expect.any(Object),
    );
    expect(mocks.deleteAssetGroup).toHaveBeenCalledWith(
      "resolved-group",
      expect.any(Object),
    );
    const [row] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, queued!.id));
    expect(row).toMatchObject({
      status: "succeeded",
      assetGroupId: "resolved-group",
      verificationTokenEncrypted: null,
    });
  });

  it("exhausts bounded transient retries and does not misclassify generic 400s", async () => {
    const [queued] = await db.insert(bytePlusIdentityCleanupsTable).values({
      tenantId,
      sourceIdentityId: 6,
      sourceAttemptId: "attempt-6",
      assetGroupId: "cleanup-exhausted",
      attempts: 7,
    }).returning();
    mocks.deleteAssetGroup.mockRejectedValueOnce(new BytePlusAssetsError("bad request", 400));

    await sweepBytePlusIdentityCleanups({ tenantId });

    const [row] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, queued!.id));
    expect(row).toMatchObject({
      status: "exhausted",
      attempts: 8,
      lastErrorCode: "retry_exhausted",
      leaseToken: null,
    });
    expect(row!.completedAt).not.toBeNull();
  });

  it("retains an unresolved recovery handle after exhaustion so it can be requeued", async () => {
    const encryptedToken = encryptJson({ token: "recover-after-outage" });
    const [queued] = await db.insert(bytePlusIdentityCleanupsTable).values({
      tenantId,
      sourceIdentityId: 7,
      sourceAttemptId: "attempt-7",
      verificationTokenEncrypted: encryptedToken,
      attempts: 7,
    }).returning();
    mocks.resolveLivenessAssetGroup.mockRejectedValueOnce(
      new BytePlusAssetsError("provider unavailable", 503),
    );

    await sweepBytePlusIdentityCleanups({ tenantId });
    const [exhausted] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, queued!.id));
    expect(exhausted).toMatchObject({
      status: "exhausted",
      verificationTokenEncrypted: encryptedToken,
      assetGroupId: null,
    });

    await db.update(bytePlusIdentityCleanupsTable).set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      completedAt: null,
    }).where(eq(bytePlusIdentityCleanupsTable.id, queued!.id));
    await sweepBytePlusIdentityCleanups({ tenantId });

    const [recovered] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, queued!.id));
    expect(recovered).toMatchObject({
      status: "succeeded",
      assetGroupId: "resolved-group",
      verificationTokenEncrypted: null,
    });
  });

  it("retains an unresolved recovery handle when lookup is permanently unsupported", async () => {
    const encryptedToken = encryptJson({ token: "unsupported-lookup" });
    const [queued] = await db.insert(bytePlusIdentityCleanupsTable).values({
      tenantId,
      sourceIdentityId: 8,
      sourceAttemptId: "attempt-8",
      verificationTokenEncrypted: encryptedToken,
    }).returning();
    mocks.resolveLivenessAssetGroup.mockRejectedValueOnce(
      new BytePlusAssetsError("unsupported", 400, "UnsupportedAction"),
    );

    await sweepBytePlusIdentityCleanups({ tenantId });

    const [row] = await db.select().from(bytePlusIdentityCleanupsTable)
      .where(eq(bytePlusIdentityCleanupsTable.id, queued!.id));
    expect(row).toMatchObject({
      status: "unsupported",
      assetGroupId: null,
      verificationTokenEncrypted: encryptedToken,
      lastErrorCode: "UnsupportedAction",
    });
  });
});