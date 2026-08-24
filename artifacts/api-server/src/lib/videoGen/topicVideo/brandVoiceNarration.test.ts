import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetProviderHealthForTests } from "../../providerHealth";
import { buildWav, synthesizeNarration } from "./narration";
import { VoiceCloneError, VoiceCloneNotConfiguredError } from "../../voiceClone";

const billing = vi.hoisted(() => ({
  reserves: [] as unknown[],
  operations: [] as unknown[],
  settlements: [] as number[],
  receipts: [] as unknown[],
  usage: [] as unknown[],
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
    refundWallet: vi.fn(async () => undefined),
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
    expect(brandSpeak).toHaveBeenCalledWith(CLONED, "First sentence.");
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
});
