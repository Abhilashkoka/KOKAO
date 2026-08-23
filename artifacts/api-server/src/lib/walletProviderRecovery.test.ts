import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  lookupResult: null as null | { provider: string; voiceId: string },
  lookupError: null as Error | null,
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
}));

import {
  BRAND_VOICE_PROVIDER_RECOVERY_STALE_MS,
  recoverBrandVoiceCloneProviderOperations,
} from "./walletProviderRecovery";
import { findClonedVoiceByExactName } from "./voiceClone";

const lookup = vi.mocked(findClonedVoiceByExactName);

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
  state.confirmations = [];
  state.failures = [];
  state.sweeps = [];
  lookup.mockClear();
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