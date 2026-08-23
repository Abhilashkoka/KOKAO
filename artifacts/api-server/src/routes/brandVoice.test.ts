import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? { userId: authState.userId, sessionClaims: { userId: authState.userId } }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock("../lib/platformFetch", async () => {
  const actual = await vi.importActual<typeof import("../lib/platformFetch")>(
    "../lib/platformFetch",
  );
  return { ...actual, platformFetch: vi.fn() };
});

vi.mock("../lib/baseVideoAudio", async () => {
  const actual = await vi.importActual<typeof import("../lib/baseVideoAudio")>(
    "../lib/baseVideoAudio",
  );
  return { ...actual, extractVoiceSampleFromVideo: vi.fn() };
});

vi.mock("../lib/videoGen/topicVideo/narration", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/videoGen/topicVideo/narration")
  >("../lib/videoGen/topicVideo/narration");
  return { ...actual, synthesizeNarration: vi.fn() };
});

const billingState = vi.hoisted(() => ({
  walletEnabled: false,
  settleFails: false,
  recordFails: false,
  reserveCalls: [] as unknown[],
  settleCalls: [] as unknown[],
  refundCalls: [] as unknown[],
  recordCalls: [] as unknown[],
}));

vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    isWalletFunded: vi.fn(async () => billingState.walletEnabled),
    reserveWallet: vi.fn(async (tenantId: number, kind: string) => {
      billingState.reserveCalls.push({ tenantId, kind });
      return { id: 97403, amountPaise: 1000, units: 1 };
    }),
    settleWalletDurably: vi.fn(async (tenantId: number, reservation: unknown, meta: unknown) => {
      billingState.settleCalls.push({ tenantId, reservation, meta });
      if (billingState.settleFails) throw new Error("settle exploded");
      return { chargedPaise: 1000, estimated: false, balancePaise: 0 };
    }),
    refundWallet: vi.fn(async (tenantId: number, reservation: unknown, note?: string) => {
      billingState.refundCalls.push({ tenantId, reservation, note });
    }),
  };
});

vi.mock("../lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/usage")>();
  return {
    ...actual,
    recordUsage: vi.fn(async (...args: Parameters<typeof actual.recordUsage>) => {
      billingState.recordCalls.push(args);
      if (billingState.recordFails) throw new Error("usage write exploded");
      return null;
    }),
  };
});

import {
  pool,
  db,
  featureFlagsTable,
  appCredentialsTable,
  brandKitsTable,
  brandVoiceExtractedSamplesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import brandKitsRouter from "./brandKits";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { addVersion, createKit } from "../lib/brandKit/service";
import { invalidateFeatureFlagCache } from "../lib/featureFlags";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { platformFetch } from "../lib/platformFetch";
import { pcmToWav } from "../lib/voiceClone";
import { pcmToWav as pcmFixtureToWav, synthVoiceSample } from "../test/voiceSampleFixtures";
import {
  BaseVideoAudioExtractionError,
  extractVoiceSampleFromVideo,
} from "../lib/baseVideoAudio";
import {
  claimBrandVoiceExtractedSample,
  registerBrandVoiceExtractedSample,
  sweepExpiredBrandVoiceExtractedSamples,
} from "../lib/brandVoiceExtractedSamples";
import { synthesizeNarration } from "../lib/videoGen/topicVideo/narration";

const platformFetchMock = vi.mocked(platformFetch);
const extractVoiceSampleFromVideoMock = vi.mocked(extractVoiceSampleFromVideo);
const synthesizeNarrationMock = vi.mocked(synthesizeNarration);

const logMock = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof logMock }).log = logMock;
    next();
  });
  app.use("/api", requireTenant, brandKitsRouter);
  return app;
}

const app = buildApp();
const realFetch = globalThis.fetch;
const savedEnvKey = process.env.ELEVENLABS_API_KEY;

let tenant: TestTenant;

/** Fake GCS file satisfying the calls the clone route makes. */
function fakeSampleFile(opts?: { contentType?: string; size?: number; bytes?: Buffer }) {
  return {
    getMetadata: async () => [
      {
        contentType: opts?.contentType ?? "audio/mpeg",
        size: opts?.size ?? 120_000,
      },
    ],
    download: async () => [opts?.bytes ?? Buffer.from("fake-audio-bytes")],
  };
}

function fakeVideoFile(opts?: { contentType?: string; size?: number }) {
  return {
    getMetadata: async () => [
      {
        contentType: opts?.contentType ?? "video/mp4",
        size: opts?.size ?? 2_000_000,
      },
    ],
    download: async () => [Buffer.from("fake-video-bytes")],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function audioResponse(pcm: Buffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
    text: async () => "",
  } as unknown as Response;
}

async function createTestKit() {
  const detail = await createKit({
    tenantId: tenant.tenantId,
    plan: "pro",
    createdBy: tenant.clerkUserId,
    name: `Voice Test ${Date.now()}`,
  });
  return detail!.id as number;
}

async function createTestKitWithBaseVideo() {
  const detail = await createKit({
    tenantId: tenant.tenantId,
    plan: "pro",
    createdBy: tenant.clerkUserId,
    name: `Voice Video Test ${Date.now()}`,
  });
  const payload = structuredClone(detail!.activeVersion!.payload);
  payload.base_videos = [
    {
      id: "base-founder",
      label: "Founder intro",
      video_path: `/objects/${tenant.tenantId}/uploads/founder-video`,
      voice_mode: "preset",
      preset_voice: "alloy",
    },
  ];
  await addVersion({
    tenantId: tenant.tenantId,
    brandKitId: detail!.id,
    createdBy: tenant.clerkUserId,
    payload,
    sourceType: "manual",
    sourceNotes: "Test base video",
    approvalStatus: "approved",
    activate: true,
  });
  return detail!.id as number;
}

async function setFlag(enabled: boolean) {
  await db
    .insert(featureFlagsTable)
    .values({ feature: "brandVoiceClone", enabled })
    .onConflictDoUpdate({
      target: featureFlagsTable.feature,
      set: { enabled },
    });
  invalidateFeatureFlagCache();
}

beforeAll(async () => {
  tenant = await createTenant();
});

afterAll(async () => {
  await db
    .delete(brandVoiceExtractedSamplesTable)
    .where(eq(brandVoiceExtractedSamplesTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
  await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "brandVoiceClone"));
  await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "voice_clone_%"));
  await pool.end();
});

beforeEach(async () => {
  // Kits accumulate across tests (each test mints its own); clear them so the
  // suite never trips the plan's brand-kit limit as tests are added.
  await db
    .delete(brandVoiceExtractedSamplesTable)
    .where(eq(brandVoiceExtractedSamplesTable.tenantId, tenant.tenantId));
  await db.delete(brandKitsTable).where(eq(brandKitsTable.tenantId, tenant.tenantId));
  resetAuthState();
  actAs(tenant.clerkUserId, "voice-test@example.com");
  billingState.walletEnabled = false;
  billingState.settleFails = false;
  billingState.recordFails = false;
  billingState.reserveCalls.length = 0;
  billingState.settleCalls.length = 0;
  billingState.refundCalls.length = 0;
  billingState.recordCalls.length = 0;
  logMock.info.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.debug.mockClear();
  platformFetchMock.mockReset();
  process.env.ELEVENLABS_API_KEY = "test-el-key";
  await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "brandVoiceClone"));
  await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "voice_clone_%"));
  invalidateFeatureFlagCache();
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
    fakeSampleFile() as never,
  );
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityUploadURL").mockResolvedValue(
    "https://storage.example/upload/preview-1?sig=x",
  );
  vi.spyOn(
    ObjectStorageService.prototype,
    "getBrandVoiceExtractionUploadURL",
  ).mockResolvedValue("https://storage.example/upload/extracted-1?sig=x");
  vi.spyOn(ObjectStorageService.prototype, "normalizeObjectEntityPath").mockReturnValue(
    "/objects/uploads/preview-1",
  );
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  extractVoiceSampleFromVideoMock.mockReset();
  extractVoiceSampleFromVideoMock.mockResolvedValue(Buffer.from("fake-extracted-mp3"));
  synthesizeNarrationMock.mockReset();
  synthesizeNarrationMock.mockResolvedValue({
    wav: Buffer.from("fake-stock-preview-wav"),
    cues: [],
    totalDurationSec: 2,
  });
});

function errorLogged(substring: string): boolean {
  return (logMock.error.mock.calls as unknown[][]).some(
    (args) => typeof args[1] === "string" && args[1].includes(substring),
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (savedEnvKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = savedEnvKey;
});

describe("GET /brand-voice/status", () => {
  it("reports enabled + configured with an env key present", async () => {
    const res = await request(app).get("/api/brand-voice/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      configured: true,
      provider: "elevenlabs",
    });
  });

  it("reports unconfigured without any key", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const res = await request(app).get("/api/brand-voice/status");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });
});

describe("DELETE /brand-voice/sample", () => {
  it("quietly deletes a rejected picked sample from the temporary namespace", async () => {
    const sampleAssetPath = `/objects/${tenant.tenantId}/voice-samples/sample-rejected`;
    const deleteObjectQuietly = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntityQuietly")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .delete("/api/brand-voice/sample")
      .send({ sampleAssetPath });

    expect(res.status).toBe(204);
    expect(deleteObjectQuietly).toHaveBeenCalledWith(sampleAssetPath, tenant.tenantId);
  });

  it("will not delete an ordinary tenant upload through sample cleanup", async () => {
    const deleteObjectQuietly = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntityQuietly")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .delete("/api/brand-voice/sample")
      .send({ sampleAssetPath: `/objects/${tenant.tenantId}/uploads/unrelated` });

    expect(res.status).toBe(400);
    expect(deleteObjectQuietly).not.toHaveBeenCalled();
  });
});

describe("POST /brand-voice/check-sample", () => {
  it("analyzes a valid WAV belonging to the current tenant", async () => {
    const wav = pcmFixtureToWav(synthVoiceSample({ seconds: 25, speechAmp: 0.4 }));
    const sampleAssetPath = `/objects/${tenant.tenantId}/uploads/valid-sample.wav`;
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeSampleFile({ size: wav.length, bytes: wav }) as never,
    );

    const res = await request(app)
      .post("/api/brand-voice/check-sample")
      .send({ sampleAssetPath });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [] });
  });

  it("rejects a sample path owned by another tenant", async () => {
    const foreignTenant = await createTenant();
    const foreignPath = `/objects/${foreignTenant.tenantId}/uploads/foreign-sample.wav`;
    const getObjectEntityFile = vi
      .spyOn(ObjectStorageService.prototype, "getObjectEntityFile")
      .mockImplementation(async (path, requestedTenantId) => {
        if (!path.startsWith(`/objects/${requestedTenantId}/`)) {
          throw new ObjectNotFoundError();
        }
        return fakeSampleFile() as never;
      });

    try {
      const res = await request(app)
        .post("/api/brand-voice/check-sample")
        .send({ sampleAssetPath: foreignPath });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "The voice sample could not be found." });
      expect(getObjectEntityFile).toHaveBeenCalledWith(foreignPath, tenant.tenantId);
    } finally {
      await deleteTenant(foreignTenant.tenantId);
    }
  });

  it("rejects a sample larger than 15 MB before downloading it", async () => {
    const download = vi.fn();
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue({
      getMetadata: async () => [{ size: 15 * 1024 * 1024 + 1 }],
      download,
    } as never);

    const res = await request(app)
      .post("/api/brand-voice/check-sample")
      .send({ sampleAssetPath: `/objects/${tenant.tenantId}/uploads/oversized.wav` });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "The voice sample is too large (max 15 MB)." });
    expect(download).not.toHaveBeenCalled();
  });

  it("fails open for undecodable sample bytes", async () => {
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeSampleFile({ size: 18, bytes: Buffer.from("not audio at all") }) as never,
    );

    const res = await request(app)
      .post("/api/brand-voice/check-sample")
      .send({ sampleAssetPath: `/objects/${tenant.tenantId}/uploads/undecodable.wav` });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [] });
    expect(logMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining("/undecodable.wav") }),
      expect.stringContaining("could not be decoded"),
    );
  });
});

describe("POST /brand-kits/:id/voice/clone", () => {
  it("clones the voice and stores it on a NEW active version", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-voice-1" }));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1", label: "Founder voice" });

    expect(res.status).toBe(201);
    const bv = res.body.activeVersion.payload.brand_voice;
    expect(bv).toMatchObject({
      mode: "cloned",
      provider: "elevenlabs",
      provider_voice_id: "el-voice-1",
      sample_asset_path: "/objects/uploads/sample-1",
      cloned_label: "Founder voice",
    });
    // Untouched sections survive the new version.
    expect(res.body.activeVersion.payload.identity).toBeTruthy();
    expect(res.body.activeVersion.payload.colors).toBeTruthy();
    // Version count grew (creation + clone).
    expect(res.body.versions.length).toBeGreaterThanOrEqual(2);
    // The provider was called with the API key header.
    const [url, init] = platformFetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("/v1/voices/add");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-el-key");
  });

  it("stores Indian English with the cloned voice and its active library entry", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-indian-1" }));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({
        sampleAssetPath: "/objects/uploads/indian-sample",
        label: "Indian English founder",
        accent: "indian_english",
      });

    expect(res.status).toBe(201);
    const bv = res.body.activeVersion.payload.brand_voice;
    expect(bv).toMatchObject({
      provider_voice_id: "el-indian-1",
      cloned_accent: "indian_english",
    });
    expect(bv.voices).toEqual([
      expect.objectContaining({
        label: "Indian English founder",
        provider_voice_id: "el-indian-1",
        accent: "indian_english",
      }),
    ]);
  });

  it("rejects an unknown voice accent before calling the provider", async () => {
    const kitId = await createTestKit();
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1", accent: "australian_english" });

    expect(res.status).toBe(400);
    expect(platformFetchMock).not.toHaveBeenCalled();
  });

  it("is blocked by the brandVoiceClone kill switch", async () => {
    const kitId = await createTestKit();
    await setFlag(false);
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });
    expect(res.status).toBe(403);
    expect(platformFetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when no provider key is configured", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const kitId = await createTestKit();
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });
    expect(res.status).toBe(503);
  });

  it("maps a provider 4xx (bad sample) to 422", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(
      jsonResponse(400, { detail: "sample too short" }),
    );
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });
    expect(res.status).toBe(422);
  });

  it("rejects a non-audio sample without touching the provider", async () => {
    const kitId = await createTestKit();
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeSampleFile({ contentType: "image/png" }) as never,
    );
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });
    expect(res.status).toBe(400);
    expect(platformFetchMock).not.toHaveBeenCalled();
  });

  it("deletes the uploaded sample from object storage when cloning fails", async () => {
    const kitId = await createTestKit();
    // Make the ElevenLabs clone call fail with a provider error.
    platformFetchMock.mockResolvedValueOnce(
      jsonResponse(400, { detail: "sample too short" }),
    );
    const deleteQuietly = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntityQuietly")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-orphan" });

    expect(res.status).toBe(422);
    // The orphaned sample must have been cleaned up.
    expect(deleteQuietly).toHaveBeenCalledWith("/objects/uploads/sample-orphan", tenant.tenantId);
  });

  it("does NOT delete the sample when cloning succeeds", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-voice-ok" }));
    const deleteQuietly = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntityQuietly")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-keep" });

    expect(res.status).toBe(201);
    expect(deleteQuietly).not.toHaveBeenCalled();
  });

  it("returns success without refunding when wallet settlement fails after cloning", async () => {
    const kitId = await createTestKit();
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-settle-fail" }));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-settle-fail" });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Voice-clone wallet settlement failed after committed work")).toBe(true);
  });

  it("never refunds when usage recording fails after wallet settlement", async () => {
    const kitId = await createTestKit();
    billingState.walletEnabled = true;
    billingState.recordFails = true;
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-usage-fail" }));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-usage-fail" });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.recordCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });
});

describe("base-video voice sample extraction", () => {
  it("extracts a saved base video's audio without calling the clone provider", async () => {
    const kitId = await createTestKitWithBaseVideo();
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeVideoFile() as never,
    );
    vi.spyOn(ObjectStorageService.prototype, "normalizeObjectEntityPath").mockReturnValue(
      `/objects/${tenant.tenantId}/voice-extracts/${kitId}/sample-1`,
    );

    const res = await request(app).post(
      `/api/brand-kits/${kitId}/base-videos/base-founder/extract-audio`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sampleAssetPath: `/objects/${tenant.tenantId}/voice-extracts/${kitId}/sample-1`,
      contentType: "audio/mpeg",
      sizeBytes: Buffer.byteLength("fake-extracted-mp3"),
      issues: [],
    });
    expect(extractVoiceSampleFromVideoMock).toHaveBeenCalledWith(
      Buffer.from("fake-video-bytes"),
    );
    expect(platformFetchMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://storage.example/upload/extracted-1?sig=x",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
  });

  it("rejects a tenant video path that is not saved on the active Brand Kit", async () => {
    const kitId = await createTestKitWithBaseVideo();
    const res = await request(app).post(
      `/api/brand-kits/${kitId}/base-videos/not-in-this-kit/extract-audio`,
    );

    expect(res.status).toBe(404);
    expect(extractVoiceSampleFromVideoMock).not.toHaveBeenCalled();
  });

  it("reports a video with no usable audio without creating a temporary object", async () => {
    const kitId = await createTestKitWithBaseVideo();
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeVideoFile() as never,
    );
    extractVoiceSampleFromVideoMock.mockRejectedValueOnce(
      new BaseVideoAudioExtractionError(),
    );

    const res = await request(app).post(
      `/api/brand-kits/${kitId}/base-videos/base-founder/extract-audio`,
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("no usable audio track");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("deletes an abandoned extracted sample from the kit's private namespace", async () => {
    const kitId = await createTestKitWithBaseVideo();
    const sampleAssetPath =
      `/objects/${tenant.tenantId}/voice-extracts/${kitId}/sample-abandoned`;
    await registerBrandVoiceExtractedSample({
      tenantId: tenant.tenantId,
      brandKitId: kitId,
      objectPath: sampleAssetPath,
    });
    const deleteObject = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/brand-kits/${kitId}/voice/extracted-sample`)
      .send({ sampleAssetPath });

    expect(res.status).toBe(204);
    expect(deleteObject).toHaveBeenCalledWith(sampleAssetPath, tenant.tenantId);
  });

  it("will not delete an ordinary tenant upload through extracted-sample cleanup", async () => {
    const kitId = await createTestKitWithBaseVideo();
    const deleteObject = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/brand-kits/${kitId}/voice/extracted-sample`)
      .send({ sampleAssetPath: `/objects/${tenant.tenantId}/uploads/unrelated` });

    expect(res.status).toBe(400);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("will not cancel a sample already claimed by an in-flight clone", async () => {
    const kitId = await createTestKitWithBaseVideo();
    const sampleAssetPath =
      `/objects/${tenant.tenantId}/voice-extracts/${kitId}/sample-in-flight`;
    await registerBrandVoiceExtractedSample({
      tenantId: tenant.tenantId,
      brandKitId: kitId,
      objectPath: sampleAssetPath,
    });
    expect(
      await claimBrandVoiceExtractedSample({
        tenantId: tenant.tenantId,
        brandKitId: kitId,
        objectPath: sampleAssetPath,
      }),
    ).toBe(true);
    const deleteObject = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/brand-kits/${kitId}/voice/extracted-sample`)
      .send({ sampleAssetPath });

    expect(res.status).toBe(409);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("expires an abandoned extracted sample even when no browser sends cleanup", async () => {
    const kitId = await createTestKitWithBaseVideo();
    const sampleAssetPath =
      `/objects/${tenant.tenantId}/voice-extracts/${kitId}/sample-expired`;
    await db.insert(brandVoiceExtractedSamplesTable).values({
      tenantId: tenant.tenantId,
      brandKitId: kitId,
      objectPath: sampleAssetPath,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const deleteObject = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue(undefined);

    expect(await sweepExpiredBrandVoiceExtractedSamples()).toBe(1);
    expect(deleteObject).toHaveBeenCalledWith(sampleAssetPath, tenant.tenantId);
    const remaining = await db
      .select({ id: brandVoiceExtractedSamplesTable.id })
      .from(brandVoiceExtractedSamplesTable)
      .where(eq(brandVoiceExtractedSamplesTable.objectPath, sampleAssetPath));
    expect(remaining).toHaveLength(0);
  });
});

describe("POST /brand-kits/:id/voice/preview", () => {
  it("409s when the kit has no cloned voice", async () => {
    const kitId = await createTestKit();
    const res = await request(app).post(`/api/brand-kits/${kitId}/voice/preview`).send({});
    expect(res.status).toBe(409);
  });

  it("speaks a preview and returns the uploaded audio path", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-voice-2" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });

    platformFetchMock.mockResolvedValueOnce(audioResponse(Buffer.alloc(48_000)));
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/preview`)
      .send({ text: "Hello from the brand voice." });

    expect(res.status).toBe(200);
    expect(res.body.audioPath).toBe("/objects/uploads/preview-1");
    const [url] = platformFetchMock.mock.calls[1]! as unknown as [string];
    expect(url).toContain("/v1/text-to-speech/el-voice-2");
  });

  it("returns success without refunding when wallet settlement fails after preview generation", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-preview-settle" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-preview-settle" });
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    billingState.recordCalls.length = 0;
    platformFetchMock.mockResolvedValueOnce(audioResponse(Buffer.alloc(48_000)));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/preview`)
      .send({ text: "Successful preview" });

    expect(res.status).toBe(200);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Voice-preview wallet settlement failed after successful work")).toBe(true);
  });

  it("never refunds a preview when usage recording fails after wallet settlement", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-preview-usage" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-preview-usage" });
    billingState.walletEnabled = true;
    billingState.recordFails = true;
    billingState.recordCalls.length = 0;
    platformFetchMock.mockResolvedValueOnce(audioResponse(Buffer.alloc(48_000)));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/preview`)
      .send({ text: "Successful preview" });

    expect(res.status).toBe(200);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.recordCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });
});

describe("POST /brand-kits/:id/voice/stock-preview", () => {
  it("speaks the selected stock voice without a cloned voice", async () => {
    const kitId = await createTestKit();

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/stock-preview`)
      .send({ presetVoice: "nova" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ audioPath: "/objects/uploads/preview-1" });
    expect(synthesizeNarrationMock).toHaveBeenCalledWith(
      [expect.stringContaining("selected stock voice")],
      "nova",
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://storage.example/upload/preview-1?sig=x",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "audio/wav" },
      }),
    );
    expect(platformFetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown stock voice before calling text-to-speech", async () => {
    const kitId = await createTestKit();

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/stock-preview`)
      .send({ presetVoice: "not-a-voice" });

    expect(res.status).toBe(400);
    expect(synthesizeNarrationMock).not.toHaveBeenCalled();
  });

  it("returns success without refunding when wallet settlement fails after stock preview generation", async () => {
    const kitId = await createTestKit();
    billingState.walletEnabled = true;
    billingState.settleFails = true;

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/stock-preview`)
      .send({ presetVoice: "nova" });

    expect(res.status).toBe(200);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(
      errorLogged("Stock-voice-preview wallet settlement failed after successful work"),
    ).toBe(true);
  });

  it("never refunds a stock preview when usage recording fails after wallet settlement", async () => {
    const kitId = await createTestKit();
    billingState.walletEnabled = true;
    billingState.recordFails = true;

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/stock-preview`)
      .send({ presetVoice: "nova" });

    expect(res.status).toBe(200);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.recordCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });
});

describe("POST /brand-kits/:id/voice/audio", () => {
  it("409s when the kit has no cloned voice", async () => {
    const kitId = await createTestKit();
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/audio`)
      .send({ text: "Hello world" });
    expect(res.status).toBe(409);
  });

  it("400s on empty text", async () => {
    const kitId = await createTestKit();
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/audio`)
      .send({ text: "   " });
    expect(res.status).toBe(400);
  });

  it("speaks the script and returns the uploaded audio path", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-voice-9" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });

    platformFetchMock.mockResolvedValueOnce(audioResponse(Buffer.alloc(48_000)));
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/audio`)
      .send({ text: "Welcome to our weekly update, spoken in my own voice." });

    expect(res.status).toBe(200);
    expect(res.body.audioPath).toBe("/objects/uploads/preview-1");
    const [url] = platformFetchMock.mock.calls[1]! as unknown as [string];
    expect(url).toContain("/v1/text-to-speech/el-voice-9");
  });

  it("returns success without refunding when wallet settlement fails after audio generation", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-audio-settle" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-audio-settle" });
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    billingState.recordCalls.length = 0;
    platformFetchMock.mockResolvedValueOnce(audioResponse(Buffer.alloc(48_000)));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/audio`)
      .send({ text: "Successful audio generation" });

    expect(res.status).toBe(200);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Voice-audio wallet settlement failed after successful work")).toBe(true);
  });

  it("never refunds generated audio when usage recording fails after wallet settlement", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-audio-usage" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-audio-usage" });
    billingState.walletEnabled = true;
    billingState.recordFails = true;
    billingState.recordCalls.length = 0;
    platformFetchMock.mockResolvedValueOnce(audioResponse(Buffer.alloc(48_000)));

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/audio`)
      .send({ text: "Successful audio generation" });

    expect(res.status).toBe(200);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.recordCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });
});

describe("voice library (multiple saved voices)", () => {
  async function cloneVoice(
    kitId: number,
    voiceId: string,
    label: string,
    accent: "american_english" | "indian_english" = "american_english",
  ) {
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: voiceId }));
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: `/objects/uploads/${voiceId}`, label, accent });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("keeps earlier voices in the library when a new one is cloned — no provider delete", async () => {
    const kitId = await createTestKit();
    await cloneVoice(kitId, "el-a", "Voice A");
    const body = await cloneVoice(kitId, "el-b", "Voice B");

    const bv = body.activeVersion.payload.brand_voice;
    expect(bv.provider_voice_id).toBe("el-b"); // newest is active
    expect(bv.cloned_label).toBe("Voice B");
    expect(bv.voices).toHaveLength(2);
    expect(bv.voices.map((v: any) => v.label)).toEqual(["Voice A", "Voice B"]);
    // The provider clone names are unique per saved voice.
    const names = platformFetchMock.mock.calls.map(([, init]) => {
      const form = (init as RequestInit).body as FormData;
      return form.get("name");
    });
    expect(new Set(names).size).toBe(2);
    // No DELETE went to the provider — Voice A stays alive.
    expect(
      platformFetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("switches the active voice via /voice/select without touching the provider", async () => {
    const kitId = await createTestKit();
    await cloneVoice(kitId, "el-a", "Voice A");
    const body = await cloneVoice(kitId, "el-b", "Voice B");
    const voiceA = body.activeVersion.payload.brand_voice.voices.find(
      (v: any) => v.label === "Voice A",
    );

    platformFetchMock.mockClear();
    await setFlag(false); // select must work even with the kill switch off
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/select`)
      .send({ voiceId: voiceA.id });

    expect(res.status).toBe(200);
    const bv = res.body.activeVersion.payload.brand_voice;
    expect(bv.provider_voice_id).toBe("el-a");
    expect(bv.cloned_label).toBe("Voice A");
    expect(bv.voices).toHaveLength(2);
    expect(platformFetchMock).not.toHaveBeenCalled();
  });

  it("keeps an Indian English entry's accent when it becomes the active voice", async () => {
    const kitId = await createTestKit();
    const first = await cloneVoice(kitId, "el-indian", "Indian English", "indian_english");
    await cloneVoice(kitId, "el-american", "American English");
    const indianVoice = first.activeVersion.payload.brand_voice.voices.find(
      (v: any) => v.provider_voice_id === "el-indian",
    );

    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/select`)
      .send({ voiceId: indianVoice.id });

    expect(res.status).toBe(200);
    expect(res.body.activeVersion.payload.brand_voice).toMatchObject({
      provider_voice_id: "el-indian",
      cloned_accent: "indian_english",
    });
  });

  it("404s selecting a voice id that is not in the library", async () => {
    const kitId = await createTestKit();
    await cloneVoice(kitId, "el-a", "Voice A");
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/select`)
      .send({ voiceId: "nope" });
    expect(res.status).toBe(404);
  });

  it("deletes one saved voice and promotes the newest remaining when it was active", async () => {
    const kitId = await createTestKit();
    await cloneVoice(kitId, "el-a", "Voice A");
    const body = await cloneVoice(kitId, "el-b", "Voice B");
    const voiceB = body.activeVersion.payload.brand_voice.voices.find(
      (v: any) => v.label === "Voice B",
    );

    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await request(app).delete(`/api/brand-kits/${kitId}/voice/entries/${voiceB.id}`);

    expect(res.status).toBe(200);
    const bv = res.body.activeVersion.payload.brand_voice;
    expect(bv.provider_voice_id).toBe("el-a"); // promoted
    expect(bv.voices).toHaveLength(1);
    const deleteCall = platformFetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(deleteCall[0]).toContain("/v1/voices/el-b");
    expect(deleteCall[1].method).toBe("DELETE");
  });

  it("clears the brand voice entirely when the last library entry is deleted", async () => {
    const kitId = await createTestKit();
    const body = await cloneVoice(kitId, "el-only", "Only voice");
    const entry = body.activeVersion.payload.brand_voice.voices[0];

    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await request(app).delete(`/api/brand-kits/${kitId}/voice/entries/${entry.id}`);

    expect(res.status).toBe(200);
    expect(res.body.activeVersion.payload.brand_voice).toBeNull();
  });

  it("caps the library at 5 saved voices with a clear 400", async () => {
    const kitId = await createTestKit();
    for (let i = 0; i < 5; i++) {
      await cloneVoice(kitId, `el-${i}`, `Voice ${i}`);
    }
    platformFetchMock.mockClear();
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/one-too-many", label: "Voice 6" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("up to 5");
    expect(platformFetchMock).not.toHaveBeenCalled();
  });

  it("removing the whole brand voice deletes EVERY library clone at the provider", async () => {
    const kitId = await createTestKit();
    await cloneVoice(kitId, "el-a", "Voice A");
    await cloneVoice(kitId, "el-b", "Voice B");

    platformFetchMock.mockClear();
    platformFetchMock.mockResolvedValue(jsonResponse(200, {}));
    const res = await request(app).delete(`/api/brand-kits/${kitId}/voice`);

    expect(res.status).toBe(200);
    expect(res.body.activeVersion.payload.brand_voice).toBeNull();
    const deletedUrls = platformFetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit)?.method === "DELETE")
      .map(([url]) => String(url));
    expect(deletedUrls.some((u) => u.includes("el-a"))).toBe(true);
    expect(deletedUrls.some((u) => u.includes("el-b"))).toBe(true);
  });
});

describe("DELETE /brand-kits/:id/voice", () => {
  it("404s when there is no brand voice", async () => {
    const kitId = await createTestKit();
    const res = await request(app).delete(`/api/brand-kits/${kitId}/voice`);
    expect(res.status).toBe(404);
  });

  it("removes the voice even when the kill switch is OFF and deletes it at the provider", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-voice-3" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });

    await setFlag(false);
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await request(app).delete(`/api/brand-kits/${kitId}/voice`);

    expect(res.status).toBe(200);
    expect(res.body.activeVersion.payload.brand_voice).toBeNull();
    const deleteCall = platformFetchMock.mock.calls[1]! as unknown as [string, RequestInit];
    expect(deleteCall[0]).toContain("/v1/voices/el-voice-3");
    expect(deleteCall[1].method).toBe("DELETE");
  });
});

describe("DELETE /brand-kits/:id (whole kit)", () => {
  it("deletes the cloned voice at the provider so no paid slot leaks", async () => {
    const kitId = await createTestKit();
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-voice-del" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });

    platformFetchMock.mockResolvedValue(jsonResponse(200, {}));
    const res = await request(app).delete(`/api/brand-kits/${kitId}`);

    expect(res.status).toBe(204);
    const deleteCalls = platformFetchMock.mock.calls
      .slice(1)
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
    expect(deleteCalls.map(([url]) => url)).toContain(
      "https://api.elevenlabs.io/v1/voices/el-voice-del",
    );
  });

  it("also cleans up a clone that only an OLDER version references", async () => {
    const kitId = await createTestKit();
    // First clone, then replace it: the replaced clone is deleted at replace
    // time, so the kit's versions reference two ids but only the latest
    // remains live at the provider. Delete must still cover the live one.
    platformFetchMock.mockResolvedValueOnce(jsonResponse(200, { voice_id: "el-old" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-1" });
    platformFetchMock.mockResolvedValue(jsonResponse(200, { voice_id: "el-new" }));
    await request(app)
      .post(`/api/brand-kits/${kitId}/voice/clone`)
      .send({ sampleAssetPath: "/objects/uploads/sample-2" });

    const res = await request(app).delete(`/api/brand-kits/${kitId}`);
    expect(res.status).toBe(204);

    const deletedUrls = platformFetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      .map(([url]) => String(url));
    expect(deletedUrls).toContain("https://api.elevenlabs.io/v1/voices/el-old");
    expect(deletedUrls).toContain("https://api.elevenlabs.io/v1/voices/el-new");
  });
});

describe("pcmToWav", () => {
  it("writes a valid RIFF header around the PCM bytes", () => {
    const pcm = Buffer.alloc(2400);
    const wav = pcmToWav(pcm, 24_000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(2400);
    expect(wav.length).toBe(44 + 2400);
  });
});
