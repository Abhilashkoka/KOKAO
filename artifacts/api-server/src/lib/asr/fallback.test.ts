import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, asrSettingsTable } from "@workspace/db";
import {
  getProviderHealth,
  recordProviderFailure,
  resetProviderHealthForTests,
} from "../providerHealth";
import { transcribeAudio, setSelectedAsrProviderId } from "./index";
import { AsrProviderError, type TranscriptionResult } from "./types";

vi.mock("../meter", () => ({
  meter: vi.fn(async (_ctx, _key, _quantity, fn) => fn()),
}));
vi.mock("../audioDuration", () => ({
  probeAudioDurationSeconds: vi.fn(async () => 7.25),
}));

vi.mock("./providers/groq", () => ({
  GROQ_MODEL: "whisper-large-v3-turbo",
  transcribeWithGroq: vi.fn(),
}));
vi.mock("./providers/openaiWhisper", () => ({
  OPENAI_ASR_MODEL: "whisper-1",
  transcribeWithOpenAI: vi.fn(),
}));
vi.mock("./providers/deepgram", () => ({
  DEEPGRAM_MODEL: "nova-2",
  transcribeWithDeepgram: vi.fn(),
}));
vi.mock("./providers/assemblyai", () => ({
  ASSEMBLYAI_MODEL: "best",
  transcribeWithAssemblyAI: vi.fn(),
}));

import { transcribeWithGroq } from "./providers/groq";
import { transcribeWithOpenAI } from "./providers/openaiWhisper";
import { transcribeWithDeepgram } from "./providers/deepgram";
import { transcribeWithAssemblyAI } from "./providers/assemblyai";
import { meter } from "../meter";
import { probeAudioDurationSeconds } from "../audioDuration";

const ENV_KEYS = ["GROQ_API_KEY", "DEEPGRAM_API_KEY", "ASSEMBLYAI_API_KEY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const audio = { buffer: Buffer.from("voice note"), mimeType: "audio/webm", filename: "note.webm" };

function result(provider: string): TranscriptionResult {
  return { text: `${provider} heard it`, provider, model: `${provider}-model` };
}

describe("transcribeAudio provider fallback", () => {
  beforeEach(async () => {
    vi.mocked(transcribeWithGroq).mockReset();
    vi.mocked(transcribeWithOpenAI).mockReset();
    vi.mocked(transcribeWithDeepgram).mockReset();
    vi.mocked(transcribeWithAssemblyAI).mockReset();
    vi.mocked(meter).mockClear();
    resetProviderHealthForTests();
    for (const key of ENV_KEYS) delete process.env[key];
    // Stored admin keys would override env config; clear them for determinism.
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "asr_%"));
    await db.delete(asrSettingsTable);
    await setSelectedAsrProviderId("groq");
    process.env.GROQ_API_KEY = "test-groq-key";
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("falls back to another configured provider on a transient failure", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("upstream down", 503));
    vi.mocked(transcribeWithOpenAI).mockResolvedValue(result("openai"));

    const out = await transcribeAudio(audio, null);
    expect(out.provider).toBe("openai");
    expect(transcribeWithGroq).toHaveBeenCalledTimes(1);
  });

  it("meters each paid fallback with a stable attempt identity", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("upstream down", 503));
    vi.mocked(transcribeWithOpenAI).mockResolvedValue(result("openai"));

    await transcribeAudio(audio, {
      tenantId: 42,
      refKind: "videoJob",
      refId: "99",
      operationKey: "video-job:99:asr",
    });

    expect(vi.mocked(meter).mock.calls.map(([ctx, key]) => [ctx?.operationKey, key])).toEqual([
      ["video-job:99:asr:provider:groq:attempt:0", "transcription"],
      ["video-job:99:asr:provider:openai:attempt:1", "transcription"],
    ]);
    expect(vi.mocked(meter).mock.calls.map(([ctx]) => ctx?.operationFamilyKey)).toEqual([
      "video-job:99:asr",
      "video-job:99:asr",
    ]);
    expect(vi.mocked(meter).mock.calls.map(([, , quantity]) => quantity)).toEqual([7.25, 7.25]);
  });

  it("does not fail over when the meter blocks a replayed successful operation", async () => {
    const replay = Object.assign(new Error("already dispatched"), {
      code: "METER_DISPATCH_REPLAY",
    });
    vi.mocked(meter).mockRejectedValueOnce(replay);
    vi.mocked(transcribeWithOpenAI).mockResolvedValue(result("openai"));

    await expect(
      transcribeAudio(audio, { tenantId: 42, operationKey: "asr-replay" }),
    ).rejects.toBe(replay);
    expect(transcribeWithGroq).not.toHaveBeenCalled();
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
  });

  it("uses a provable byte-based upper bound when duration probing fails", async () => {
    vi.mocked(probeAudioDurationSeconds).mockResolvedValueOnce(null);
    vi.mocked(transcribeWithGroq).mockResolvedValue(result("groq"));

    await transcribeAudio(audio, { tenantId: 42, operationKey: "asr-unprobeable" });

    expect(vi.mocked(meter).mock.calls[0]?.[2]).toBe(audio.buffer.length);
  });

  it("does not fall back on a permanent error", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValue(
      new AsrProviderError("unsupported audio format", 400),
    );

    await expect(transcribeAudio(audio, null)).rejects.toThrow("unsupported audio format");
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
  });

  it("prefers the healthiest alternate when a breaker is open", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    for (let i = 0; i < 3; i++) recordProviderFailure("asr:openai");
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("rate limited", 429));
    vi.mocked(transcribeWithDeepgram).mockResolvedValue(result("deepgram"));

    const out = await transcribeAudio(audio, null);
    expect(out.provider).toBe("deepgram");
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
  });

  it("tries the second alternate when the first also fails transiently", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("down", 502));
    vi.mocked(transcribeWithOpenAI).mockRejectedValue(new AsrProviderError("also down", 503));
    vi.mocked(transcribeWithDeepgram).mockResolvedValue(result("deepgram"));

    const out = await transcribeAudio(audio, null);
    expect(out.provider).toBe("deepgram");
  });

  it("stops after two alternates and rethrows the primary error", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    process.env.ASSEMBLYAI_API_KEY = "test-aai-key";
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("primary down", 503));
    vi.mocked(transcribeWithOpenAI).mockRejectedValue(new AsrProviderError("second down", 503));
    vi.mocked(transcribeWithDeepgram).mockRejectedValue(new AsrProviderError("third down", 503));

    await expect(transcribeAudio(audio, null)).rejects.toThrow("primary down");
    expect(transcribeWithAssemblyAI).not.toHaveBeenCalled();
  });

  it("records transient failures and clears them on success", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValueOnce(new AsrProviderError("down", 503));
    vi.mocked(transcribeWithOpenAI).mockResolvedValue(result("openai"));
    await transcribeAudio(audio, null);
    expect(getProviderHealth("asr:groq")?.consecutiveFailures).toBe(1);
    expect(getProviderHealth("asr:openai")?.consecutiveFailures).toBe(0);

    vi.mocked(transcribeWithGroq).mockResolvedValue(result("groq"));
    await transcribeAudio(audio, null);
    expect(getProviderHealth("asr:groq")?.consecutiveFailures).toBe(0);
  });

  it("does not count a permanent error against provider health", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("bad key", 401));
    await expect(transcribeAudio(audio, null)).rejects.toThrow("bad key");
    expect(getProviderHealth("asr:groq")).toBeNull();
  });
});
