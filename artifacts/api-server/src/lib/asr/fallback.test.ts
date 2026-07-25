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

    const out = await transcribeAudio(audio);
    expect(out.provider).toBe("openai");
    expect(transcribeWithGroq).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on a permanent error", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValue(
      new AsrProviderError("unsupported audio format", 400),
    );

    await expect(transcribeAudio(audio)).rejects.toThrow("unsupported audio format");
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
  });

  it("prefers the healthiest alternate when a breaker is open", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    for (let i = 0; i < 3; i++) recordProviderFailure("asr:openai");
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("rate limited", 429));
    vi.mocked(transcribeWithDeepgram).mockResolvedValue(result("deepgram"));

    const out = await transcribeAudio(audio);
    expect(out.provider).toBe("deepgram");
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
  });

  it("tries the second alternate when the first also fails transiently", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("down", 502));
    vi.mocked(transcribeWithOpenAI).mockRejectedValue(new AsrProviderError("also down", 503));
    vi.mocked(transcribeWithDeepgram).mockResolvedValue(result("deepgram"));

    const out = await transcribeAudio(audio);
    expect(out.provider).toBe("deepgram");
  });

  it("stops after two alternates and rethrows the primary error", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    process.env.ASSEMBLYAI_API_KEY = "test-aai-key";
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("primary down", 503));
    vi.mocked(transcribeWithOpenAI).mockRejectedValue(new AsrProviderError("second down", 503));
    vi.mocked(transcribeWithDeepgram).mockRejectedValue(new AsrProviderError("third down", 503));

    await expect(transcribeAudio(audio)).rejects.toThrow("primary down");
    expect(transcribeWithAssemblyAI).not.toHaveBeenCalled();
  });

  it("records transient failures and clears them on success", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValueOnce(new AsrProviderError("down", 503));
    vi.mocked(transcribeWithOpenAI).mockResolvedValue(result("openai"));
    await transcribeAudio(audio);
    expect(getProviderHealth("asr:groq")?.consecutiveFailures).toBe(1);
    expect(getProviderHealth("asr:openai")?.consecutiveFailures).toBe(0);

    vi.mocked(transcribeWithGroq).mockResolvedValue(result("groq"));
    await transcribeAudio(audio);
    expect(getProviderHealth("asr:groq")?.consecutiveFailures).toBe(0);
  });

  it("does not count a permanent error against provider health", async () => {
    vi.mocked(transcribeWithGroq).mockRejectedValue(new AsrProviderError("bad key", 401));
    await expect(transcribeAudio(audio)).rejects.toThrow("bad key");
    expect(getProviderHealth("asr:groq")).toBeNull();
  });
});
