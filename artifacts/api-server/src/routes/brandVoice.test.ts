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

import { pool, db, featureFlagsTable, appCredentialsTable, brandKitsTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import brandKitsRouter from "./brandKits";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { createKit } from "../lib/brandKit/service";
import { invalidateFeatureFlagCache } from "../lib/featureFlags";
import { ObjectStorageService } from "../lib/objectStorage";
import { platformFetch } from "../lib/platformFetch";
import { pcmToWav } from "../lib/voiceClone";

const platformFetchMock = vi.mocked(platformFetch);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
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
function fakeSampleFile(opts?: { contentType?: string; size?: number }) {
  return {
    getMetadata: async () => [
      {
        contentType: opts?.contentType ?? "audio/mpeg",
        size: opts?.size ?? 120_000,
      },
    ],
    download: async () => [Buffer.from("fake-audio-bytes")],
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
  await deleteTenant(tenant.tenantId);
  await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "brandVoiceClone"));
  await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "voice_clone_%"));
  await pool.end();
});

beforeEach(async () => {
  // Kits accumulate across tests (each test mints its own); clear them so the
  // suite never trips the plan's brand-kit limit as tests are added.
  await db.delete(brandKitsTable).where(eq(brandKitsTable.tenantId, tenant.tenantId));
  resetAuthState();
  actAs(tenant.clerkUserId, "voice-test@example.com");
  platformFetchMock.mockReset();
  process.env.ELEVENLABS_API_KEY = "test-el-key";
  await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "brandVoiceClone"));
  invalidateFeatureFlagCache();
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
    fakeSampleFile() as never,
  );
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityUploadURL").mockResolvedValue(
    "https://storage.example/upload/preview-1?sig=x",
  );
  vi.spyOn(ObjectStorageService.prototype, "normalizeObjectEntityPath").mockReturnValue(
    "/objects/uploads/preview-1",
  );
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
});

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
