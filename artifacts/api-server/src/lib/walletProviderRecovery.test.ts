import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  lookupResult: null as null | { provider: string; voiceId: string },
  lookupError: null as Error | null,
  ttsMatches: [] as Array<{ providerResultId: string; requestId: string | null; createdAt: Date }>,
  confirmations: [] as unknown[],
  failures: [] as unknown[],
  sweeps: [] as Date[],
}));

vi.mock("./wallet", () => ({
  listPendingWalletProviderOperations: vi.fn(async () => state.rows),
  confirmWalletProviderOperationSucceeded: vi.fn(async (...args: unknown[]) => {
    state.confirmations.push(args);
  }),
  sweepWalletProviderOperations: vi.fn(async (now: Date) => {
    state.sweeps.push(now);
    return { settled: 0, refunded: 0, failed: 0 };
  }),
}));

vi.mock("./voiceClone", () => ({
  findClonedVoiceByExactName: vi.fn(async () => {
    if (state.lookupError) throw state.lookupError;
    return state.lookupResult;
  }),
  findBrandVoiceTtsHistoryMatches: vi.fn(async () => state.ttsMatches),
}));

import {
  BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS,
  recoverBrandVoiceCloneProviderOperations,
  recoverBrandVoiceTtsProviderOperations,
} from "./walletProviderRecovery";
import {
  findBrandVoiceTtsHistoryMatches,
  findClonedVoiceByExactName,
} from "./voiceClone";

const lookup = vi.mocked(findClonedVoiceByExactName);
const ttsLookup = vi.mocked(findBrandVoiceTtsHistoryMatches);

function pendingClone(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    operationKind: "brand_voice_clone",
    operationKey: "kokao-brand-voice-r9001",
    provider: "elevenlabs",
    createdAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = [];
  state.lookupResult = null;
  state.lookupError = null;
  state.ttsMatches = [];
  state.confirmations = [];
  state.failures = [];
  state.sweeps = [];
  lookup.mockClear();
  ttsLookup.mockClear();
});

describe("Brand Voice TTS provider-operation recovery", () => {
  it("confirms an exact unclaimed ElevenLabs history item", async () => {
    const now = new Date(BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 10_000);
    state.rows = [{
      id: 51,
      operationKind: "brand_voice_tts",
      operationKey: "brand-voice-tts-v1:voice:model:digest",
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      createdAt: new Date(0),
    }];
    state.ttsMatches = [{
      providerResultId: "history-51",
      requestId: "request-51",
      createdAt: new Date(1_000),
    }];

    await expect(recoverBrandVoiceTtsProviderOperations(now)).resolves.toEqual({
      found: 1,
      absent: 0,
      pending: 0,
    });
    expect(ttsLookup).toHaveBeenCalledWith(
      "elevenlabs",
      "brand-voice-tts-v1:voice:model:digest",
      new Date(0),
    );
    expect(state.confirmations).toContainEqual([
      51,
      {
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        providerResultId: "history-51",
      },
    ]);
  });

  it("leaves absent TTS history pending rather than guessing a refund", async () => {
    const now = new Date(BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 10_000);
    state.rows = [{
      id: 52,
      operationKind: "brand_voice_tts",
      operationKey: "brand-voice-tts-v1:voice:model:digest",
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      createdAt: new Date(0),
    }];

    await expect(recoverBrandVoiceTtsProviderOperations(now)).resolves.toEqual({
      found: 0,
      absent: 1,
      pending: 1,
    });
    expect(state.confirmations).toHaveLength(0);
  });

  it("leaves multiple identical history matches pending as ambiguous", async () => {
    const now = new Date(BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 10_000);
    state.rows = [{
      id: 53,
      operationKind: "brand_voice_tts",
      operationKey: "brand-voice-tts-v1:voice:model:digest",
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      createdAt: new Date(0),
    }];
    state.ttsMatches = [
      { providerResultId: "history-53-a", requestId: null, createdAt: new Date(1_000) },
      { providerResultId: "history-53-b", requestId: null, createdAt: new Date(2_000) },
    ];

    await expect(recoverBrandVoiceTtsProviderOperations(now)).resolves.toEqual({
      found: 0,
      absent: 0,
      pending: 1,
    });
    expect(state.confirmations).toHaveLength(0);
    expect(state.sweeps).toEqual([now]);
  });
});

describe("Brand Voice provider-operation recovery", () => {
  it("confirms an exact provider match and leaves settlement to the durable sweep", async () => {
    const now = new Date(BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 10_000);
    state.rows = [pendingClone()];
    state.lookupResult = { provider: "elevenlabs", voiceId: "voice-confirmed-after-restart" };

    await expect(recoverBrandVoiceCloneProviderOperations(now)).resolves.toEqual({
      found: 1,
      absent: 0,
      pending: 0,
    });
    expect(lookup).toHaveBeenCalledWith("elevenlabs", "kokao-brand-voice-r9001");
    expect(state.confirmations).toEqual([
      [
        41,
        {
          provider: "elevenlabs",
          model: "voice-clone",
          providerResultId: "voice-confirmed-after-restart",
        },
      ],
    ]);
    expect(state.failures).toHaveLength(0);
    expect(state.sweeps).toEqual([now]);
  });

  it("keeps a missing search result pending rather than guessing a refund", async () => {
    const now = new Date(BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 10_000);
    state.rows = [pendingClone()];

    await expect(recoverBrandVoiceCloneProviderOperations(now)).resolves.toEqual({
      found: 0,
      absent: 1,
      pending: 1,
    });
    expect(state.confirmations).toHaveLength(0);
    expect(state.failures).toHaveLength(0);
    expect(state.sweeps).toEqual([now]);
  });

  it("keeps ambiguous lookup failures pending and never guesses a refund", async () => {
    const now = new Date(BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 10_000);
    state.rows = [pendingClone()];
    state.lookupError = new Error("provider unavailable");

    await expect(recoverBrandVoiceCloneProviderOperations(now)).resolves.toEqual({
      found: 0,
      absent: 0,
      pending: 1,
    });
    expect(state.confirmations).toHaveLength(0);
    expect(state.failures).toHaveLength(0);
    expect(state.sweeps).toEqual([now]);
  });

  it("does not probe an operation until its response-loss grace period has elapsed", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    state.rows = [
      pendingClone({
        createdAt: new Date(now.getTime() - BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS + 1),
      }),
    ];

    await expect(recoverBrandVoiceCloneProviderOperations(now)).resolves.toEqual({
      found: 0,
      absent: 0,
      pending: 1,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(state.confirmations).toHaveLength(0);
    expect(state.failures).toHaveLength(0);
  });
});