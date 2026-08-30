import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetProviderHealthForTests } from "../../providerHealth";
import { buildWav, synthesizeNarration } from "./narration";
import { synthesizeGuidedNarration } from "./index";
import { VoiceCloneError, VoiceCloneNotConfiguredError } from "../../voiceClone";

const billing = vi.hoisted(() => ({
  reserves: [] as unknown[],
  operations: [] as unknown[],
  settlements: [] as number[],
  receipts: [] as unknown[],
  usage: [] as unknown[],
  refunds: [] as unknown[],
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
    isWalletFunded: vi.fn(async () => true),
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
      CLONED, "First sentence.", undefined, "eleven_multilingual_v2", undefined,
    );
    expect(stockSpeak).not.toHaveBeenCalled();
    expect(narration.cues).toHaveLength(2);
    expect(narration.totalDurationSec).toBeGreaterThan(2);
  });

  it("reserves and settles every cloned narration sentence from its receipt", async () => {
    brandSpeak.mockImplementation(async (_voice, _text, onReceipt) => {
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
      billing: { tenantId: 77, refKind: "videoJob", refId: "42" },
    });

    expect(billing.reserves).toHaveLength(2);
    expect(billing.operations).toHaveLength(2);
    expect(billing.receipts).toHaveLength(2);
    expect(billing.settlements).toEqual([201, 202]);
    expect(billing.usage).toHaveLength(2);
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
