import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetProviderHealthForTests } from "../../providerHealth";
import { buildWav, synthesizeNarration } from "./narration";
import { synthesizeGuidedNarration } from "./index";
import { VoiceCloneError, VoiceCloneNotConfiguredError } from "../../voiceClone";
import { MeterDispatchReplayError } from "../../meterErrors";

const billing = vi.hoisted(() => ({
  reserves: [] as unknown[],
  operations: [] as unknown[],
  settlements: [] as number[],
  receipts: [] as unknown[],
  usage: [] as unknown[],
  refunds: [] as unknown[],
  walletFunded: true,
}));

vi.mock("@workspace/integrations-openai-ai-server/audio", () => ({
  textToSpeech: vi.fn(),
}));

vi.mock("../../voiceClone", async () => {
  const actual = await vi.importActual<typeof import("../../voiceClone")>("../../voiceClone");
  return { ...actual, speakWithClonedVoiceReceipt: vi.fn() };
});
vi.mock("../../aiCost", async () => {
  const actual = await vi.importActual<typeof import("../../aiCost")>("../../aiCost");
  return {
    ...actual,
    getAiCostConfig: vi.fn(async () => ({ elevenLabsInrPerCredit: "0.01" })),
  };
});
vi.mock("../../wallet", async () => {
  const actual = await vi.importActual<typeof import("../../wallet")>("../../wallet");
  return {
    ...actual,
    isWalletFunded: vi.fn(async () => billing.walletFunded),
    reserveWallet: vi.fn(async (...args: unknown[]) => {
      billing.reserves.push(args);
      return { id: 100 + billing.reserves.length, amountPaise: 12, units: 1 };
    }),
    executeWalletProviderOperation: vi.fn(async (
      params: unknown,
      perform: (
        confirm: (meta: unknown) => Promise<void>,
        record: (meta: unknown) => Promise<void>,
      ) => Promise<unknown>,
    ) => {
      billing.operations.push(params);
      let confirmed = false;
      const value = await perform(
        async () => {
          confirmed = true;
        },
        async (meta) => {
          billing.receipts.push(meta);
        },
      );
      return { value, operationId: 200 + billing.operations.length, confirmed };
    }),
    settleWalletProviderOperationDurably: vi.fn(async (id: number) => {
      billing.settlements.push(id);
      return { chargedPaise: 1, estimated: false };
    }),
    refundWallet: vi.fn(async (...args: unknown[]) => {
      billing.refunds.push(args);
    }),
  };
});
vi.mock("../../usage", () => ({
  recordUsage: vi.fn(async (...args: unknown[]) => {
    billing.usage.push(args);
  }),
}));

import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { speakWithClonedVoiceReceipt } from "../../voiceClone";

const brandSpeak = vi.mocked(speakWithClonedVoiceReceipt);
const stockSpeak = vi.mocked(textToSpeech);

/** Mono pcm16 WAV of the given length. */
function wav(durationSec: number, sampleRate = 24_000): Buffer {
  const byteRate = sampleRate * 2;
  return buildWav(
    { channels: 1, sampleRate, bitsPerSample: 16, byteRate, blockAlign: 2 },
    Buffer.alloc(Math.round(byteRate * durationSec)),
  );
}

const CLONED = { provider: "elevenlabs", voiceId: "el-brand-1" };
const SENTENCES = ["First sentence.", "Second sentence."];

describe("resolveNarrationVoice", () => {
  it("prefers the kit's preset voice when the job carries no explicit voice", async () => {
    const { resolveNarrationVoice } = await import("./narration");
    expect(resolveNarrationVoice(undefined, "nova")).toBe("nova");
    expect(resolveNarrationVoice(null, "shimmer")).toBe("shimmer");
  });

  it("lets an explicit job voice override the kit preset", async () => {
    const { resolveNarrationVoice } = await import("./narration");
    expect(resolveNarrationVoice("echo", "nova")).toBe("echo");
  });

  it("falls back to the default narrator only when neither is set or valid", async () => {
    const { resolveNarrationVoice } = await import("./narration");
    expect(resolveNarrationVoice(undefined, undefined)).toBe("alloy");
    expect(resolveNarrationVoice("not-a-voice", "also-bad")).toBe("alloy");
  });
});

describe("synthesizeNarration with a cloned brand voice", () => {
  beforeEach(() => {
    brandSpeak.mockReset();
    stockSpeak.mockReset();
    billing.reserves.length = 0;
    billing.operations.length = 0;
    billing.settlements.length = 0;
    billing.receipts.length = 0;
    billing.usage.length = 0;
    billing.refunds.length = 0;
    billing.walletFunded = true;
    resetProviderHealthForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("speaks the whole track in the brand voice, never touching stock TTS", async () => {
    brandSpeak.mockResolvedValue({
      audio: wav(1),
      receipt: { providerCredits: "10", requestId: "req", traceId: null },
    });

    const narration = await synthesizeNarration(SENTENCES, "alloy", { clonedVoice: CLONED });

    expect(brandSpeak).toHaveBeenCalledTimes(SENTENCES.length);
    expect(brandSpeak).toHaveBeenCalledWith(
      CLONED,
      "First sentence.",
      null,
      undefined,
      "eleven_multilingual_v2",
      undefined,
    );
    expect(stockSpeak).not.toHaveBeenCalled();
    expect(narration.cues).toHaveLength(2);
    expect(narration.totalDurationSec).toBeGreaterThan(2);
  });

  it("keeps repeated cloned sentences in distinct stage families", async () => {
    billing.walletFunded = false;
    brandSpeak.mockResolvedValue({
      audio: wav(1),
      receipt: { providerCredits: "10", requestId: "req", traceId: null },
    });

    await synthesizeNarration(["Repeat this.", "Repeat this."], "alloy", {
      clonedVoice: CLONED,
      meterContext: {
        tenantId: 7,
        refKind: "videoJob",
        refId: "42",
        funding: { tenantId: 7, rail: "quota", mode: "enforce" },
        operationKey: "video-job:42:narration",
        operationFamilyKey: "video-job:42:narration",
      },
      billing: {
        tenantId: 7,
        refKind: "videoJob",
        refId: "42:0",
        operationScope: { jobId: 42, cueIndex: 0, stage: "narration" },
        operationFamilyKey: "video-job:42:narration",
      },
    });

    const firstCallContext = brandSpeak.mock.calls[0]?.[2];
    const secondCallContext = brandSpeak.mock.calls[1]?.[2];
    expect(firstCallContext?.operationFamilyKey).toBe("video-job:42:narration:sentence:0");
    expect(secondCallContext?.operationFamilyKey).toBe("video-job:42:narration:sentence:1");
    expect(firstCallContext?.operationKey).toBe(
      "video-job:42:narration:sentence:0:attempt:0",
    );
    expect(secondCallContext?.operationKey).toBe(
      "video-job:42:narration:sentence:1:attempt:0",
    );
  });

  it("reserves and settles every cloned narration sentence from its receipt", async () => {
    brandSpeak.mockImplementation(async (_voice, _text, _meterContext, onReceipt) => {
      const receipt = {
        providerCredits: "10",
        requestId: `request-${billing.receipts.length + 1}`,
        traceId: null,
      };
      await onReceipt?.(receipt);
      return { audio: wav(1), receipt };
    });

    await synthesizeNarration(SENTENCES, "alloy", {
      clonedVoice: CLONED,
      billing: {
        tenantId: 77,
        refKind: "videoJob",
        refId: "42",
        // Simulate an enforce-mode parent route. The independently reserved
        // cloned narration must still use wallet-shadow and never debit the
        // credit account.
        funding: Object.freeze({
          tenantId: 77,
          rail: "credits" as const,
          mode: "enforce" as const,
        }),
      },
    });

    expect(billing.reserves).toHaveLength(2);
    expect(billing.operations).toHaveLength(2);
    expect(billing.receipts).toHaveLength(2);
    expect(billing.settlements).toEqual([201, 202]);
    expect(billing.usage).toHaveLength(2);
    expect(brandSpeak.mock.calls).toHaveLength(2);
    for (const [, , meterContext] of brandSpeak.mock.calls) {
      expect(meterContext).toEqual(
        expect.objectContaining({
          tenantId: 77,
          funding: expect.objectContaining({
            tenantId: 77,
            rail: "wallet",
            mode: "shadow",
          }),
        }),
      );
      expect(Object.isFrozen(meterContext?.funding)).toBe(true);
    }
  });

  it("falls back to the stock voices for the ENTIRE track when the brand voice fails", async () => {
    // First sentence speaks fine, second dies: nothing from the brand voice
    // may survive — the whole track must be re-spoken on stock TTS.
    brandSpeak
      .mockResolvedValueOnce({
        audio: wav(1),
        receipt: { providerCredits: "10", requestId: "req", traceId: null },
      })
      .mockRejectedValue(new VoiceCloneError("provider down", 503));
    stockSpeak.mockResolvedValue(wav(1));

    const narration = await synthesizeNarration(SENTENCES, "nova", { clonedVoice: CLONED });

    expect(stockSpeak).toHaveBeenCalledTimes(SENTENCES.length);
    expect(narration.cues).toHaveLength(2);
  });

  it("does not fall back to stock narration when cloned metering blocks a replay", async () => {
    brandSpeak.mockRejectedValueOnce(new MeterDispatchReplayError());

    await expect(
      synthesizeNarration(["The launch is live."], "alloy", {
        clonedVoice: CLONED,
        billing: {
          tenantId: 77,
          refKind: "guidedStoryLine",
          refId: "line-replay",
        },
      }),
    ).rejects.toBeInstanceOf(MeterDispatchReplayError);

    expect(stockSpeak).not.toHaveBeenCalled();
  });

  it("keeps a required cloned voice on the frozen enforce rail", async () => {
    billing.walletFunded = false;
    brandSpeak.mockRejectedValue(new VoiceCloneError("voice unavailable", 400));

    await expect(
      synthesizeNarration(["The launch is live."], "alloy", {
        clonedVoice: CLONED,
        requireClonedVoice: true,
        billing: {
          tenantId: 77,
          refKind: "guidedStoryLine",
          refId: "line-enforce",
          funding: Object.freeze({
            tenantId: 77,
            rail: "credits" as const,
            mode: "enforce" as const,
          }),
        },
      }),
    ).rejects.toThrow(/voice unavailable/u);

    expect(stockSpeak).not.toHaveBeenCalled();
    expect(billing.reserves).toHaveLength(0);
    expect(billing.operations).toHaveLength(0);
    expect(brandSpeak).toHaveBeenCalledWith(
      CLONED,
      "The launch is live.",
      expect.objectContaining({
        funding: expect.objectContaining({
          tenantId: 77,
          rail: "credits",
          mode: "enforce",
        }),
      }),
      undefined,
      "eleven_multilingual_v2",
      undefined,
    );
  });

  it("falls back when voice cloning is not configured at all", async () => {
    brandSpeak.mockRejectedValue(new VoiceCloneNotConfiguredError());
    stockSpeak.mockResolvedValue(wav(1));

    const narration = await synthesizeNarration(SENTENCES, "alloy", { clonedVoice: CLONED });

    expect(stockSpeak).toHaveBeenCalledTimes(SENTENCES.length);
    expect(narration.cues).toHaveLength(2);
  });

  it("uses stock voices directly when no cloned voice is supplied", async () => {
    stockSpeak.mockResolvedValue(wav(1));

    await synthesizeNarration(SENTENCES, "alloy");

    expect(brandSpeak).not.toHaveBeenCalled();
    expect(stockSpeak).toHaveBeenCalledTimes(SENTENCES.length);
  });

  it("uses v3 and the frozen Telugu locale for Guided Story role narration", async () => {
    brandSpeak.mockResolvedValue({
      audio: wav(1),
      receipt: { providerCredits: "10", requestId: "req", traceId: null },
    });
    const script = {
      version: 1, title: "కథ", logline: "", runtimeSeconds: 1, warnings: [],
      roles: [{ id: "role-1", name: "పాత్ర", description: "" }],
      scenes: [{
        id: "scene-1", startMs: 0, endMs: 1000, visualDirection: "",
        roleIds: ["role-1"],
        lines: [{
          id: "line-1", ownerRoleId: "role-1", kind: "dialogue",
          text: "ఇది తెలుగు కథ", startMs: 0, endMs: 1000,
        }],
      }],
    } as any;
    await synthesizeGuidedNarration({
      tenantId: 77,
      script,
      locale: "te-IN",
      cast: [{
        roleId: "role-1", characterId: null, outfitId: null,
        voice: { id: "brand", label: "Brand", provider: "elevenlabs", providerVoiceId: "el-brand-1" },
      }] as any,
      fallbackVoice: "alloy",
      upload: async () => "tenant/77/guided.wav",
    });
    expect(brandSpeak).toHaveBeenCalledWith(
      CLONED,
      "ఇది తెలుగు కథ",
      expect.objectContaining({
        tenantId: 77,
        refKind: "guidedStoryLine",
        refId: "line-1",
        operationFamilyKey: expect.stringContaining("sentence:0"),
        operationKey: expect.stringContaining("sentence:0:attempt:0"),
      }),
      expect.any(Function),
      "eleven_v3",
      "te",
    );
    expect(billing.reserves[0]).toEqual(expect.arrayContaining([
      77, "caption", { provider: "elevenlabs", model: "eleven_v3" },
    ]));
    expect(billing.operations[0]).toMatchObject({
      settlement: { model: "eleven_v3", refKind: "guidedStoryLine", refId: "line-1" },
    });
  });

  it("forwards the owning enforced credit rail to Guided Story cloned narration", async () => {
    billing.walletFunded = false;
    brandSpeak.mockResolvedValue({
      audio: wav(1),
      receipt: { providerCredits: "10", requestId: "req-credit", traceId: null },
    });
    const script = {
      version: 1, title: "Story", logline: "", runtimeSeconds: 1, warnings: [],
      roles: [{ id: "role-1", name: "Role", description: "" }],
      scenes: [{
        id: "scene-1", startMs: 0, endMs: 1000, visualDirection: "",
        roleIds: ["role-1"],
        lines: [{
          id: "line-credit", ownerRoleId: "role-1", kind: "dialogue",
          text: "A credit-funded line.", startMs: 0, endMs: 1000,
        }],
      }],
    } as any;

    await synthesizeGuidedNarration({
      tenantId: 77,
      videoJobId: 88,
      script,
      locale: "te-IN",
      cast: [{
        roleId: "role-1", characterId: null, outfitId: null,
        voice: { id: "brand", label: "Brand", provider: "elevenlabs", providerVoiceId: "el-brand-1" },
      }] as any,
      fallbackVoice: "alloy",
      meterContext: {
        tenantId: 77,
        refKind: "videoJob",
        refId: "88",
        funding: Object.freeze({
          tenantId: 77,
          rail: "credits",
          mode: "enforce",
        }),
        operationKey: "videoJob:88:guided-narration",
      },
      upload: async () => "tenant/77/guided-credit.wav",
    });

    expect(brandSpeak).toHaveBeenCalledWith(
      CLONED,
      "A credit-funded line.",
      expect.objectContaining({
        tenantId: 77,
        refKind: "videoJob",
        funding: expect.objectContaining({
          tenantId: 77,
          rail: "credits",
          mode: "enforce",
        }),
      }),
      undefined,
      "eleven_v3",
      "te",
    );
  });

  it("rejects Telugu v2 before reserving and refunds confirmed provider failures", async () => {
    await expect(synthesizeNarration(["తెలుగు"], "alloy", {
      clonedVoice: CLONED,
      requireClonedVoice: true,
      billing: { tenantId: 77 },
      languageCode: "te",
    })).rejects.toThrow(/does not support Telugu/u);
    expect(billing.reserves).toHaveLength(0);
    expect(billing.operations).toHaveLength(0);

    brandSpeak.mockRejectedValue(new VoiceCloneError("voice unavailable", 400));
    await expect(synthesizeNarration(["English"], "alloy", {
      clonedVoice: CLONED,
      requireClonedVoice: true,
      billing: { tenantId: 77 },
    })).rejects.toThrow(/voice unavailable/u);
    // The bounded retry starts a distinct provider operation each time; every
    // confirmed failure is resolved by refunding its matching reservation.
    expect(billing.refunds).toHaveLength(2);
  });
});
