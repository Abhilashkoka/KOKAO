import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, aiModelPricesTable, appCredentialsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  NVIDIA_CREDENTIAL_PROVIDER,
  clearNvidiaCoreDeployment,
  clearNvidiaHostedApiKey,
  getNvidiaCoreConfigView,
  getNvidiaCoreDeployment,
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaHostedApiKey,
  resolveNvidiaCoreDeployment,
  setNvidiaCoreDeployment,
  setNvidiaHostedApiKey,
  testNvidiaHostedCatalog,
  testNvidiaCoreDeployment,
} from "./nvidiaCore";
import { computeTextCostPaise, setAiCostConfig, upsertModelPrice } from "./aiCost";
import { getNvidiaAdminSettings, setNvidiaDeployment, testNvidiaHosted } from "./nvidiaAdmin";
import { getVideoGenKeySource, getVideoGenProviderDef } from "./videoGen";
import { transcribeWithNvidia } from "./asr/providers/nvidia";
import { TTS_PROVIDERS } from "./videoGen/topicVideo/tts";

const originalKey = process.env.NVIDIA_API_KEY;
const realFetch = globalThis.fetch;

async function cleanup() {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, NVIDIA_CREDENTIAL_PROVIDER));
  await db.delete(aiModelPricesTable).where(
    and(
      eq(aiModelPricesTable.provider, "nvidia"),
      eq(aiModelPricesTable.model, "wan-ai/wan2.2"),
    ),
  );
  await db.delete(aiModelPricesTable).where(
    and(
      eq(aiModelPricesTable.provider, "nvidia"),
      eq(aiModelPricesTable.model, "stabilityai/stable-diffusion-xl"),
    ),
  );
  await db.delete(aiModelPricesTable).where(
    and(
      eq(aiModelPricesTable.provider, "nvidia"),
      eq(aiModelPricesTable.model, "meta/llama-3.1-70b-instruct"),
    ),
  );
}

beforeEach(async () => {
  delete process.env.NVIDIA_API_KEY;
  globalThis.fetch = realFetch;
  await cleanup();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await cleanup();
  if (originalKey === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = originalKey;
});

describe("NVIDIA core deployment registry", () => {
  it("encrypts the hosted key and masks all keys from status", async () => {
    await setNvidiaHostedApiKey("nvapi-secret");
    await setNvidiaCoreDeployment({
      capability: "text",
      kind: "hosted",
      protocol: "openai-chat",
      model: "meta/llama-3.1-70b-instruct",
      baseUrl: "https://ignored.example",
      apiKey: "endpoint-secret",
      enabled: true,
    });

    const [row] = await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, NVIDIA_CREDENTIAL_PROVIDER));
    expect(row!.encryptedCredentials).not.toContain("nvapi-secret");
    expect(row!.encryptedCredentials).not.toContain("endpoint-secret");
    expect(JSON.stringify(await getNvidiaCoreConfigView())).not.toContain("secret");
    expect(await resolveNvidiaHostedApiKey()).toBe("nvapi-secret");
  });

  it("rejects unverified hosted models and incompatible protocols", async () => {
    await expect(
      setNvidiaCoreDeployment({
        capability: "text",
        kind: "hosted",
        protocol: "openai-chat",
        model: "unknown/catalog-entry",
        baseUrl: "",
      }),
    ).rejects.toThrow("verified adapter");

    await expect(
      setNvidiaCoreDeployment({
        capability: "asr",
        kind: "self-hosted",
        protocol: "openai-chat",
        model: "parakeet",
        baseUrl: "https://api.nvidia.com/v1",
      }),
    ).rejects.toThrow("openai-audio-transcriptions");
  });

  it("keeps the verified hosted multimodal chat deployment available to admins", async () => {
    await setNvidiaCoreDeployment({
      capability: "multimodal",
      kind: "hosted",
      protocol: "openai-chat",
      model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
      baseUrl: "https://ignored.example",
      enabled: false,
    });

    expect(await getNvidiaCoreDeployment("multimodal")).toMatchObject({
      capability: "multimodal",
      kind: "hosted",
      protocol: "openai-chat",
      model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
      baseUrl: "https://integrate.api.nvidia.com/v1",
    });
  });

  it("blocks unsafe self-hosted endpoint URLs", async () => {
    await expect(
      setNvidiaCoreDeployment({
        capability: "tts",
        kind: "self-hosted",
        protocol: "openai-audio-speech",
        model: "riva-tts",
        baseUrl: "http://127.0.0.1:8000/v1",
      }),
    ).rejects.toThrow(/https|blocked|private/);
  });

  it("restricts self-hosted image deployments to a verified NIM model and protocol", async () => {
    await expect(
      setNvidiaCoreDeployment({
        capability: "image",
        kind: "self-hosted",
        protocol: "nvidia-image-v1",
        model: "catalog/unverified-image",
        baseUrl: "https://api.nvidia.com/v1",
      }),
    ).rejects.toThrow("verified NIM adapter");
  });

  it("requires a successful model test and explicit price before activation", async () => {
    await setNvidiaCoreDeployment({
      capability: "text",
      kind: "hosted",
      protocol: "openai-chat",
      model: "meta/llama-3.1-70b-instruct",
      baseUrl: "",
      enabled: true,
    });
    await setNvidiaHostedApiKey("nvapi-test");
    expect(await isNvidiaCoreDeploymentActivatable("text")).toBe(false);
    await setAiCostConfig({ usdToInrPaise: 8_000 });
    await upsertModelPrice({
      kind: "text",
      provider: "nvidia",
      model: "meta/llama-3.1-70b-instruct",
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 1,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "meta/llama-3.1-70b-instruct" }] }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await testNvidiaCoreDeployment("text");

    expect(await isNvidiaCoreDeploymentActivatable("text")).toBe(true);
    expect(
      await computeTextCostPaise({
        provider: "nvidia",
        model: "meta/llama-3.1-70b-instruct",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(16_000);
    expect((await getNvidiaCoreDeployment("text"))?.lastTestStatus).toBe("ok");
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      "Bearer nvapi-test",
    );

    await setNvidiaDeployment("text", {
      kind: "hosted",
      model: "meta/llama-3.1-70b-instruct",
      protocol: "openai-chat",
      enabled: true,
    });
    expect(await isNvidiaCoreDeploymentActivatable("text")).toBe(true);

    await setNvidiaDeployment("text", {
      kind: "hosted",
      model: "meta/llama-3.1-70b-instruct",
      protocol: "openai-chat",
      enabled: true,
      adminPriceUsd: null,
    });
    expect(await isNvidiaCoreDeploymentActivatable("text")).toBe(false);
  });

  it("clears deployments and rotates back to the environment key", async () => {
    process.env.NVIDIA_API_KEY = "env-key";
    await setNvidiaHostedApiKey("db-key");
    await clearNvidiaHostedApiKey();
    expect(await resolveNvidiaHostedApiKey()).toBe("env-key");
    await clearNvidiaCoreDeployment("text");
    expect(await getNvidiaCoreDeployment("text")).toBeNull();
  });

  it("tests the hosted catalog at its single /v1/models URL", async () => {
    await setNvidiaHostedApiKey("hosted-key");
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await testNvidiaHostedCatalog();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(await getNvidiaAdminSettings()).toMatchObject({
      hosted: {
        lastTestStatus: "ok",
        lastTestedAt: expect.any(String),
        lastTestError: null,
      },
    });
  });

  it("persists a masked hosted test failure without leaking the credential", async () => {
    await setNvidiaHostedApiKey("nvapi-do-not-leak");
    globalThis.fetch = vi.fn(async () =>
      new Response("Bearer nvapi-do-not-leak was rejected", { status: 401 }),
    ) as typeof fetch;

    const result = await testNvidiaHosted();
    const settings = await getNvidiaAdminSettings();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("[REDACTED]");
    expect(JSON.stringify({ result, settings })).not.toContain("nvapi-do-not-leak");
    expect(settings.hosted).toMatchObject({
      lastTestStatus: "error",
      lastTestedAt: result.testedAt,
      lastTestError: expect.stringContaining("[REDACTED]"),
    });
  });

  it("invalidates hosted credential and deployment tests on rotation and clear", async () => {
    await setNvidiaHostedApiKey("first-key");
    await setNvidiaCoreDeployment({
      capability: "text",
      kind: "hosted",
      protocol: "openai-chat",
      model: "meta/llama-3.1-70b-instruct",
      baseUrl: "",
      enabled: true,
    });
    await setNvidiaCoreDeployment({
      capability: "multimodal",
      kind: "hosted",
      protocol: "openai-chat",
      model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
      baseUrl: "",
      enabled: true,
    });
    await setNvidiaCoreDeployment({
      capability: "asr",
      kind: "self-hosted",
      protocol: "openai-audio-transcriptions",
      model: "nvidia/parakeet-ctc-1.1b-asr",
      baseUrl: "https://api.nvidia.com",
      enabled: true,
      adminPriceUsd: 0,
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        data: [
          { id: "meta/llama-3.1-70b-instruct" },
          { id: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" },
          { id: "nvidia/parakeet-ctc-1.1b-asr" },
        ],
      }),
    ) as typeof fetch;
    await testNvidiaHosted();
    await testNvidiaCoreDeployment("text");
    await testNvidiaCoreDeployment("multimodal");
    await testNvidiaCoreDeployment("asr");

    await setNvidiaHostedApiKey("second-key");
    let view = await getNvidiaCoreConfigView();
    expect(view.hostedLastTestStatus).toBeNull();
    expect(view.deployments.text?.lastTestStatus).toBeNull();
    expect(view.deployments.multimodal?.lastTestStatus).toBeNull();
    expect(view.deployments.asr?.lastTestStatus).toBe("ok");
    expect(await isNvidiaCoreDeploymentActivatable("text")).toBe(false);

    await testNvidiaHosted();
    await testNvidiaCoreDeployment("text");
    await clearNvidiaHostedApiKey();
    view = await getNvidiaCoreConfigView();
    expect(view.hostedLastTestStatus).toBeNull();
    expect(view.deployments.text?.lastTestStatus).toBeNull();
    expect(view.deployments.asr?.lastTestStatus).toBe("ok");
    expect(await isNvidiaCoreDeploymentActivatable("text")).toBe(false);
  });

  it("writes an admin NVIDIA text rate into the cost table used for receipts", async () => {
    await setAiCostConfig({ usdToInrPaise: 8_000 });
    await setNvidiaDeployment("text", {
      kind: "hosted",
      model: "meta/llama-3.1-70b-instruct",
      protocol: "openai-chat",
      adminPriceUsd: 2,
    });
    expect(
      await computeTextCostPaise({
        provider: "nvidia",
        model: "meta/llama-3.1-70b-instruct",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(32_000);
  });

  it("preserves a self-hosted image endpoint key on update", async () => {
    await setNvidiaCoreDeployment({
      capability: "image",
      kind: "self-hosted",
      protocol: "nvidia-image-v1",
      model: "stabilityai/stable-diffusion-xl",
      baseUrl: "https://example.com/v1",
      apiKey: "endpoint-key",
      enabled: true,
    });
    const deployment = await resolveNvidiaCoreDeployment("image");
    expect(deployment?.apiKey).toBe("endpoint-key");
    await setNvidiaCoreDeployment({
      capability: "image",
      kind: "self-hosted",
      protocol: "nvidia-image-v1",
      model: "stabilityai/stable-diffusion-xl",
      baseUrl: "https://example.com/v1",
      enabled: true,
    });
    expect((await resolveNvidiaCoreDeployment("image"))?.apiKey).toBe("endpoint-key");
    expect(await isNvidiaCoreDeploymentActivatable("image")).toBe(false);
  });

  it("rejects hosted image saves because Catalog image has no independent test", async () => {
    await expect(
      setNvidiaCoreDeployment({
      capability: "image",
      kind: "hosted",
      protocol: "nvidia-image-v1",
      model: "stabilityai/stable-diffusion-xl",
      baseUrl: "https://ignored.example",
      enabled: true,
      }),
    ).rejects.toThrow("non-billable independent test");
  });

  it("tests and activates a keyless self-hosted image NIM", async () => {
    await setNvidiaCoreDeployment({
      capability: "image",
      kind: "self-hosted",
      protocol: "nvidia-image-v1",
      model: "stabilityai/stable-diffusion-xl",
      baseUrl: "https://api.nvidia.com",
      enabled: true,
    });
    await setAiCostConfig({ usdToInrPaise: 8_000 });
    await upsertModelPrice({
      kind: "image",
      provider: "nvidia",
      model: "stabilityai/stable-diffusion-xl",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.01,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.nvidia.com/v1/models");
      expect(init?.headers).toEqual({});
      return Response.json({ data: [{ id: "stabilityai/stable-diffusion-xl" }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await testNvidiaCoreDeployment("image");
    expect((await resolveNvidiaCoreDeployment("image"))?.resolvedApiKey).toBeNull();
    expect(await isNvidiaCoreDeploymentActivatable("image")).toBe(true);

    await setNvidiaDeployment("image", {
      kind: "self-hosted",
      protocol: "nvidia-image-v1",
      model: "stabilityai/stable-diffusion-xl",
      baseUrl: "https://api.nvidia.com/v1",
      enabled: true,
      adminPriceUsd: null,
    });
    expect(await isNvidiaCoreDeploymentActivatable("image")).toBe(false);
  });

  it("accepts only self-hosted WAN 2.2 video and requires a per-second price", async () => {
    await expect(
      setNvidiaCoreDeployment({
        capability: "video",
        kind: "hosted",
        protocol: "nvidia-video-v1",
        model: "wan-ai/wan2.2",
        baseUrl: "",
        enabled: true,
      }),
    ).rejects.toThrow("only through a self-hosted");

    await setNvidiaCoreDeployment({
      capability: "video",
      kind: "self-hosted",
      protocol: "nvidia-video-v1",
      model: "wan-ai/wan2.2",
      baseUrl: "https://api.nvidia.com",
      enabled: true,
    });
    expect((await getNvidiaCoreDeployment("video"))?.baseUrl).toBe("https://api.nvidia.com/v1");
    await setAiCostConfig({ usdToInrPaise: 8_000 });
    await upsertModelPrice({
      kind: "video",
      provider: "nvidia",
      model: "wan-ai/wan2.2",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.1,
      usdPerVideo: null,
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: [{ id: "wan-ai/wan2.2" }] }),
    ) as typeof fetch;
    await testNvidiaCoreDeployment("video");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      "https://api.nvidia.com/v1/models",
    );
    expect(await isNvidiaCoreDeploymentActivatable("video")).toBe(true);

    await setNvidiaDeployment("video", {
      kind: "self-hosted",
      protocol: "nvidia-video-v1",
      model: "wan-ai/wan2.2",
      baseUrl: "https://api.nvidia.com/v1",
      enabled: true,
      adminPriceUsd: null,
    });
    expect(await isNvidiaCoreDeploymentActivatable("video")).toBe(false);
  });

  it("reports a keyless self-hosted video deployment through deployment state, not as a missing key", async () => {
    await setNvidiaCoreDeployment({
      capability: "video",
      kind: "self-hosted",
      protocol: "nvidia-video-v1",
      model: "wan-ai/wan2.2",
      baseUrl: "https://api.nvidia.com",
      enabled: true,
    });
    await setAiCostConfig({ usdToInrPaise: 8_000 });
    await upsertModelPrice({
      kind: "video",
      provider: "nvidia",
      model: "wan-ai/wan2.2",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.1,
      usdPerVideo: null,
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: [{ id: "wan-ai/wan2.2" }] }),
    ) as typeof fetch;
    await testNvidiaCoreDeployment("video");

    const nvidiaVideo = getVideoGenProviderDef("nvidia")!;
    expect(await getVideoGenKeySource(nvidiaVideo)).toBe("database");
    expect(await isNvidiaCoreDeploymentActivatable("video")).toBe(true);
    const view = await getNvidiaAdminSettings();
    expect(view.deployments.find((deployment) => deployment.capability === "video")).toMatchObject({
      configured: true,
      apiKeyMasked: null,
      enabled: true,
    });
  });

  it("activates self-hosted speech only with an explicit USD 0 confirmation", async () => {
    await setNvidiaDeployment("asr", {
      kind: "self-hosted",
      baseUrl: "https://api.nvidia.com",
      model: "nvidia/parakeet-ctc-1.1b-asr",
      protocol: "openai-audio-transcriptions",
      enabled: true,
      adminPriceUsd: 0,
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: [{ id: "nvidia/parakeet-ctc-1.1b-asr" }] }),
    ) as typeof fetch;
    await testNvidiaCoreDeployment("asr");
    expect((await getNvidiaCoreDeployment("asr"))?.baseUrl).toBe("https://api.nvidia.com/v1");
    expect((await getNvidiaCoreConfigView()).deployments.asr?.adminPriceUsd).toBe(0);
    expect(await isNvidiaCoreDeploymentActivatable("asr")).toBe(true);

    await setNvidiaDeployment("asr", {
      kind: "self-hosted",
      baseUrl: "https://api.nvidia.com/v1",
      model: "nvidia/parakeet-ctc-1.1b-asr",
      protocol: "openai-audio-transcriptions",
      enabled: true,
      adminPriceUsd: null,
    });
    expect(await isNvidiaCoreDeploymentActivatable("asr")).toBe(false);
  });

  it("rejects hosted speech and nonzero paid audio pricing", async () => {
    await expect(
      setNvidiaDeployment("tts", {
        kind: "hosted",
        model: "nvidia/magpie-tts",
        protocol: "openai-audio-speech",
        adminPriceUsd: 0,
      }),
    ).rejects.toThrow("hosted speech");
    await expect(
      setNvidiaDeployment("tts", {
        kind: "self-hosted",
        baseUrl: "https://api.nvidia.com/v1",
        model: "nvidia/magpie-tts",
        protocol: "openai-audio-speech",
        adminPriceUsd: 0.01,
      }),
    ).rejects.toThrow("paid audio has no accounting unit");
  });

  it("rejects unsupported self-hosted chat and speech models even when their endpoint lists them", async () => {
    await expect(
      setNvidiaCoreDeployment({
        capability: "text",
        kind: "self-hosted",
        baseUrl: "https://api.nvidia.com",
        model: "nvidia/nv-embed-v2",
        protocol: "openai-chat",
        enabled: true,
      }),
    ).rejects.toThrow("does not have a verified adapter");

    await expect(
      setNvidiaCoreDeployment({
        capability: "asr",
        kind: "self-hosted",
        baseUrl: "https://api.nvidia.com",
        model: "nvidia/unknown-speech-model",
        protocol: "openai-audio-transcriptions",
        enabled: true,
        adminPriceUsd: 0,
      }),
    ).rejects.toThrow("does not have a verified adapter");
  });

  it("uses the verified multipart ASR and TTS Speech NIM contracts", async () => {
    for (const [capability, model, protocol] of [
      ["asr", "nvidia/parakeet-ctc-1.1b-asr", "openai-audio-transcriptions"],
      ["tts", "nvidia/magpie-tts", "openai-audio-speech"],
    ] as const) {
      await setNvidiaDeployment(capability, {
        kind: "self-hosted",
        baseUrl: "https://api.nvidia.com",
        model,
        protocol,
        enabled: true,
        adminPriceUsd: 0,
      });
      globalThis.fetch = vi.fn(async () => Response.json({ data: [{ id: model }] })) as typeof fetch;
      await testNvidiaCoreDeployment(capability);
    }

    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init!]);
      if (String(url).endsWith("/transcriptions")) {
        return Response.json({
          text: " Hello world ",
          segments: [{ start: 0.25, end: 1.5, text: "Hello world" }],
        });
      }
      const wav = Buffer.alloc(44);
      wav.write("RIFF", 0, "ascii");
      wav.write("WAVE", 8, "ascii");
      return new Response(wav);
    }) as typeof fetch;

    const transcript = await transcribeWithNvidia({
      buffer: Buffer.from("audio"),
      mimeType: "audio/wav",
      filename: "voice.wav",
      timestamps: true,
      language: "en",
    }, null);
    await TTS_PROVIDERS.find((provider) => provider.id === "nvidia")!
      .speak("Keep this exact text.", "nova", null);

    expect(transcript.segments).toEqual([{ startMs: 250, endMs: 1500, text: "Hello world" }]);
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.nvidia.com/v1/audio/transcriptions",
      "https://api.nvidia.com/v1/audio/synthesize",
    ]);
    expect((calls[0]![1].body as FormData).get("language")).toBe("en");
    expect((calls[0]![1].body as FormData).get("response_format")).toBe("verbose_json");
    expect((calls[1]![1].body as FormData).get("text")).toBe("Keep this exact text.");
    expect((calls[1]![1].body as FormData).get("voice")).toBe("nova");
    expect((calls[1]![1].headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
});