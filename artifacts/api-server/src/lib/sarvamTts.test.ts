import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  SARVAM_APP_CREDENTIALS_PROVIDER,
  SARVAM_ENV_KEY,
  SARVAM_TTS_ENDPOINT,
  SARVAM_TTS_MODEL,
  getStoredSarvamKey,
  setStoredSarvamKey,
  clearStoredSarvamKey,
  getSarvamKeySource,
  resolveSarvamApiKey,
  isSarvamConfigured,
  resolveSarvamLocale,
  isSarvamTransientError,
  speakWithSarvam,
  testSarvamKey,
  createSarvamCueSpeaker,
  persistSarvamTestStatus,
  persistSarvamTestStatusForCredential,
  resolveSarvamCredentialSnapshot,
  getSarvamTestStatus,
  sarvamTtsHealthKey,
} from "./sarvamTts";
import { VideoGenProviderError } from "./videoGen/types";

// ---------------------------------------------------------------------------
// DB-backed tests (hit real dev DB, clean up after themselves)
// ---------------------------------------------------------------------------

const originalEnv = process.env[SARVAM_ENV_KEY];

async function cleanup(): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, SARVAM_APP_CREDENTIALS_PROVIDER));
}

beforeEach(async () => {
  delete process.env[SARVAM_ENV_KEY];
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  if (originalEnv === undefined) delete process.env[SARVAM_ENV_KEY];
  else process.env[SARVAM_ENV_KEY] = originalEnv;
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Sarvam TTS constants", () => {
  it("uses the correct credentials slot", () => {
    expect(SARVAM_APP_CREDENTIALS_PROVIDER).toBe("tts_sarvam");
  });

  it("targets the documented API endpoint", () => {
    expect(SARVAM_TTS_ENDPOINT).toBe("https://api.sarvam.ai/text-to-speech");
  });

  it("defaults to bulbul:v3 model", () => {
    expect(SARVAM_TTS_MODEL).toBe("bulbul:v3");
  });

  it("uses the tts:sarvam health key", () => {
    expect(sarvamTtsHealthKey()).toBe("tts:sarvam");
  });
});

// ---------------------------------------------------------------------------
// Locale mapping
// ---------------------------------------------------------------------------

describe("resolveSarvamLocale", () => {
  it.each(["te-IN", "ta-IN", "hi-IN"])(
    "passes through supported locale %s unchanged",
    (locale) => {
      expect(resolveSarvamLocale(locale)).toBe(locale);
    },
  );

  it("maps short KOKAO locales to Sarvam BCP-47 locales", () => {
    expect(resolveSarvamLocale("te")).toBe("te-IN");
    expect(resolveSarvamLocale("ta")).toBe("ta-IN");
    expect(resolveSarvamLocale("hi")).toBe("hi-IN");
  });

  it("rejects unsupported or missing locales instead of silently speaking Hindi", () => {
    expect(() => resolveSarvamLocale("xx-XX")).toThrow(/Telugu, Tamil, and Hindi/);
    expect(() => resolveSarvamLocale(undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("isSarvamTransientError", () => {
  it("classifies 429 as transient", () => {
    expect(isSarvamTransientError(new VideoGenProviderError("rate limit", 429))).toBe(true);
  });

  it.each([500, 502, 503, 504])("classifies %i as transient", (status) => {
    expect(isSarvamTransientError(new VideoGenProviderError("server error", status))).toBe(true);
  });

  it("classifies VideoGenProviderError with no status (timeout/network) as transient", () => {
    expect(isSarvamTransientError(new VideoGenProviderError("timed out"))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])(
    "classifies permanent 4xx (%i) as non-transient",
    (status) => {
      expect(isSarvamTransientError(new VideoGenProviderError("bad request", status))).toBe(false);
    },
  );

  it("classifies a plain Error as transient (network / unknown)", () => {
    expect(isSarvamTransientError(new Error("fetch failed"))).toBe(true);
  });

  it("classifies non-Error as non-transient", () => {
    expect(isSarvamTransientError("string error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Key storage and resolution (DB)
// ---------------------------------------------------------------------------

describe("Sarvam key storage and resolution", () => {
  it("returns null when no key is stored anywhere", async () => {
    expect(await getStoredSarvamKey()).toBeNull();
    expect(await getSarvamKeySource()).toBeNull();
    expect(await resolveSarvamApiKey()).toBeNull();
    expect(await isSarvamConfigured()).toBe(false);
  });

  it("stores the key encrypted and round-trips it", async () => {
    await setStoredSarvamKey("sarvam-test-key-abc");
    const row = (
      await db
        .select()
        .from(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, SARVAM_APP_CREDENTIALS_PROVIDER))
    )[0];
    expect(row).toBeDefined();
    // Must not contain the plaintext key
    expect(row!.encryptedCredentials).not.toContain("sarvam-test-key-abc");
    expect(await getStoredSarvamKey()).toBe("sarvam-test-key-abc");
    expect(await getSarvamKeySource()).toBe("database");
    expect(await isSarvamConfigured()).toBe(true);
  });

  it("prefers the stored DB key over the env secret", async () => {
    process.env[SARVAM_ENV_KEY] = "env-key-sarvam";
    expect(await getSarvamKeySource()).toBe("env");
    expect(await resolveSarvamApiKey()).toBe("env-key-sarvam");

    await setStoredSarvamKey("db-key-sarvam");
    expect(await getSarvamKeySource()).toBe("database");
    expect(await resolveSarvamApiKey()).toBe("db-key-sarvam");
  });

  it("falls back to env after the stored key is cleared", async () => {
    process.env[SARVAM_ENV_KEY] = "env-key-sarvam";
    await setStoredSarvamKey("db-key-sarvam");
    await clearStoredSarvamKey();
    expect(await getStoredSarvamKey()).toBeNull();
    expect(await getSarvamKeySource()).toBe("env");
    expect(await resolveSarvamApiKey()).toBe("env-key-sarvam");
  });

  it("overwrites an existing stored key (rotate)", async () => {
    await setStoredSarvamKey("first-key");
    await setStoredSarvamKey("second-key");
    expect(await getStoredSarvamKey()).toBe("second-key");
  });

  it("reports null key source after key is cleared with no env fallback", async () => {
    await setStoredSarvamKey("some-key");
    await clearStoredSarvamKey();
    expect(await isSarvamConfigured()).toBe(false);
  });

  it("uses env key when set and no DB row exists", async () => {
    process.env[SARVAM_ENV_KEY] = "only-env-key";
    expect(await isSarvamConfigured()).toBe(true);
    expect(await resolveSarvamApiKey()).toBe("only-env-key");
  });
});

// ---------------------------------------------------------------------------
// Test status persistence
// ---------------------------------------------------------------------------

describe("Sarvam test status persistence", () => {
  it("returns null values when no credential row exists", async () => {
    const status = await getSarvamTestStatus();
    expect(status.lastTestStatus).toBeNull();
    expect(status.lastTestedAt).toBeNull();
    expect(status.lastTestError).toBeNull();
  });

  it("persists ok status after a successful test", async () => {
    await setStoredSarvamKey("some-key");
    await persistSarvamTestStatus("ok");
    const status = await getSarvamTestStatus();
    expect(status.lastTestStatus).toBe("ok");
    expect(status.lastTestedAt).toBeInstanceOf(Date);
    expect(status.lastTestError).toBeNull();
  });

  it("persists error status with message", async () => {
    await setStoredSarvamKey("some-key");
    await persistSarvamTestStatus("error", "The API key was rejected (401)");
    const status = await getSarvamTestStatus();
    expect(status.lastTestStatus).toBe("error");
    expect(status.lastTestError).toBe("The API key was rejected (401)");
  });

  it("does nothing when there is no credential row (test without stored key)", async () => {
    // Should not throw even though there is no row to update
    await expect(persistSarvamTestStatus("ok")).resolves.toBeUndefined();
  });

  it("persists status for an env-only key without copying the key into the DB", async () => {
    process.env[SARVAM_ENV_KEY] = "env-only-status-key";
    const credential = await resolveSarvamCredentialSnapshot();
    expect(credential?.source).toBe("env");

    expect(
      await persistSarvamTestStatusForCredential(credential!, "ok"),
    ).toBe(true);
    expect(await getStoredSarvamKey()).toBeNull();
    expect(await getSarvamKeySource()).toBe("env");
    expect((await getSarvamTestStatus()).lastTestStatus).toBe("ok");
  });

  it("does not attach an old key's test result to a concurrently rotated key", async () => {
    await setStoredSarvamKey("old-key");
    const oldCredential = await resolveSarvamCredentialSnapshot();
    await setStoredSarvamKey("new-key");

    expect(
      await persistSarvamTestStatusForCredential(oldCredential!, "ok"),
    ).toBe(false);
    expect(await getStoredSarvamKey()).toBe("new-key");
    expect((await getSarvamTestStatus()).lastTestStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createSarvamCueSpeaker — returns null when not configured
// ---------------------------------------------------------------------------

describe("createSarvamCueSpeaker", () => {
  it("returns null when no API key is available", async () => {
    const speaker = await createSarvamCueSpeaker("shubh");
    expect(speaker).toBeNull();
  });

  it("binds one resolved key and selected speaker across the whole track", async () => {
    await setStoredSarvamKey("track-key");
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    const fetchMock = vi.fn(async (_url, init: RequestInit | undefined) => {
      expect((init?.headers as Record<string, string>)["api-subscription-key"]).toBe("track-key");
      const body = JSON.parse(String(init?.body));
      expect(body.speaker).toBe("priya");
      return {
        ok: true,
        status: 200,
        json: async () => ({ audios: [wav.toString("base64")] }),
      } as Response;
    });
    global.fetch = fetchMock as typeof fetch;

    const speaker = await createSarvamCueSpeaker("priya");
    expect(speaker).not.toBeNull();
    // Rotation/removal after the job has started cannot switch this track to a
    // different credential or provider midway through synthesis.
    await clearStoredSarvamKey();
    await speaker!("முதல் வரி.", "ta");
    await speaker!("இரண்டாம் வரி.", "ta");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// speakWithSarvam — fetch mocks (no real HTTP calls in unit tests)
// ---------------------------------------------------------------------------

describe("speakWithSarvam (mocked fetch)", () => {
  // Build a minimal valid WAV-like buffer (44+ bytes)
  function fakeWavBase64(): string {
    const buf = Buffer.alloc(100);
    buf.write("RIFF", 0, "ascii");
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.write("data", 36, "ascii");
    return buf.toString("base64");
  }

  it("decodes base64 audios and returns a Buffer when API responds ok", async () => {
    const fakeAudio = fakeWavBase64();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audios: [fakeAudio] }),
    } as Response);

    const result = await speakWithSarvam("Hello", "fake-key", "hi-IN", "priya");
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(100);
    expect(global.fetch).toHaveBeenCalledOnce();

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit & { headers?: Record<string, string> },
    ];
    expect(url).toBe(SARVAM_TTS_ENDPOINT);
    expect(init.headers?.["api-subscription-key"]).toBe("fake-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(SARVAM_TTS_MODEL);
    expect(body.target_language_code).toBe("hi-IN");
    expect(body.text).toBe("Hello");
    expect(body.speaker).toBe("priya");
    expect(body.speech_sample_rate).toBe(24_000);
    expect(body.enable_preprocessing).toBeUndefined();
    expect(body.output_audio_codec).toBeUndefined();
    // No audio samples sent — voice cloning is separate
    expect(body.voice_id).toBeUndefined();
  });

  it("throws VideoGenProviderError for non-ok HTTP status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as unknown as Response);

    await expect(speakWithSarvam("Hello", "bad-key", "hi-IN", "shubh")).rejects.toThrow(
      VideoGenProviderError,
    );
  });

  it("classifies 429 error status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    } as unknown as Response);

    const err = await speakWithSarvam("Hello", "some-key", "hi-IN", "shubh").catch((e) => e);
    expect(err).toBeInstanceOf(VideoGenProviderError);
    expect((err as VideoGenProviderError).status).toBe(429);
    expect(isSarvamTransientError(err)).toBe(true);
  });

  it("throws when audios array is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audios: [] }),
    } as Response);

    await expect(speakWithSarvam("Hello", "fake-key", "hi-IN", "shubh")).rejects.toThrow(
      /Sarvam TTS returned no audio data/,
    );
  });

  it("throws when response has no audios field", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(speakWithSarvam("Hello", "fake-key", "hi-IN", "shubh")).rejects.toThrow(VideoGenProviderError);
  });

  it("throws when decoded audio is too small to be a WAV", async () => {
    const tinyBuf = Buffer.alloc(10);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audios: [tinyBuf.toString("base64")] }),
    } as Response);

    await expect(speakWithSarvam("Hello", "fake-key", "hi-IN", "shubh")).rejects.toThrow(
      /too small to be a valid WAV/,
    );
  });

  it("throws VideoGenProviderError on AbortError (timeout)", async () => {
    global.fetch = vi.fn().mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) => {
        // Immediately abort to simulate a timeout
        if (init?.signal) {
          return new Promise<Response>((_, reject) => {
            const err = new DOMException("The operation was aborted.", "AbortError");
            // Fire synchronously so test is fast
            setImmediate(() => reject(err));
          });
        }
        return Promise.reject(new Error("no signal"));
      },
    );

    // Trigger the abort by dispatching abort on a fresh controller
    // Actually we need to simulate it being aborted; easiest is to spy
    // on the AbortController prototype
    const origAbort = AbortController.prototype.abort;
    let abortCalled = false;
    AbortController.prototype.abort = function () {
      abortCalled = true;
      origAbort.call(this);
    };
    try {
      const err = await speakWithSarvam("Hello", "fake-key", "hi-IN", "shubh").catch((e) => e);
      expect(err).toBeInstanceOf(VideoGenProviderError);
    } finally {
      AbortController.prototype.abort = origAbort;
    }
    // We can't easily trigger the exact timing in unit test; just verify
    // the error class is correct on a network failure
    void abortCalled;
  });

  it("does not include any audio/sample/voice_id fields in the request body (no voice cloning)", async () => {
    const fakeAudio = fakeWavBase64();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audios: [fakeAudio] }),
    } as Response);

    await speakWithSarvam("Test cue", "fake-key", "te-IN", "neha");

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    const body = JSON.parse(init.body);
    expect(body.voice_sample).toBeUndefined();
    expect(body.voice_id).toBeUndefined();
    expect(body.cloning_samples).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// testSarvamKey convenience
// ---------------------------------------------------------------------------

describe("testSarvamKey (mocked fetch)", () => {
  it("resolves without error when speakWithSarvam succeeds", async () => {
    const buf = Buffer.alloc(100);
    buf.write("RIFF", 0, "ascii");
    buf.write("WAVE", 8, "ascii");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audios: [buf.toString("base64")] }),
    } as Response);

    await expect(testSarvamKey("valid-key")).resolves.toBeUndefined();
  });

  it("throws when speakWithSarvam fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    } as unknown as Response);

    await expect(testSarvamKey("bad-key")).rejects.toThrow(VideoGenProviderError);
  });
});
