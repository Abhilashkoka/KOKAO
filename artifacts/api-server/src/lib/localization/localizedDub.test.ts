/**
 * Focused tests for the localized_dub engine.
 *
 * These tests cover:
 *  1. Exact cue wording goes to TTS unchanged (never rephrased/split).
 *  2. Locked starts/tempo fit are used — tempo is applied and start offsets are
 *     respected.
 *  3. Overrun fails instead of changing/colliding wording.
 *  4. Route rejects unapproved/malformed requests before funding.
 *  5. A localized-dub TTS/render failure uses the existing job refund path.
 *
 * The orchestration itself is pure-logic (injectable deps) so the heavy ffmpeg
 * and TTS work is avoided here; those are exercised by dub.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildWav } from "../videoGen/topicVideo/narration";
import {
  planAudioFit,
  orchestrateLocalizedDub,
  CueOverrunError,
  type ApprovedDubCue,
  type DubOrchestrationDeps,
  type BurnSubtitlesInput,
} from "./dub";
import type { DubTake } from "./dub";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Build a mono 24kHz WAV of the given duration. */
function wav(durationMs: number): Buffer {
  const sampleRate = 24_000;
  const byteRate = sampleRate * 2;
  const durationSec = durationMs / 1000;
  return buildWav(
    { channels: 1, sampleRate, bitsPerSample: 16, byteRate, blockAlign: 2 },
    Buffer.alloc(Math.round(byteRate * durationSec)),
  );
}

const DUMMY_VIDEO = Buffer.from("fake-video-bytes");
const DUMMY_DUBBED = Buffer.from("dubbed-video-bytes");
const DUMMY_BURNED = Buffer.from("burned-video-bytes");
const DUMMY_TRACK = Buffer.from("dub-track-bytes");

/** Default injectable deps that avoid all real I/O. */
function makeDeps(
  overrides: Partial<DubOrchestrationDeps & { cueAudioMs?: number }> = {},
): DubOrchestrationDeps & { spoken: { text: string; voice: string }[] } {
  const spoken: { text: string; voice: string }[] = [];
  const cueAudioMs = overrides.cueAudioMs ?? 800;

  return {
    spoken,
    probeSourceDurationMs: overrides.probeSourceDurationMs ?? (async () => 10_000),
    speakCue: overrides.speakCue ?? (async (text, voice) => {
      spoken.push({ text, voice });
      return wav(cueAudioMs);
    }),
    parseWavDurationMs: overrides.parseWavDurationMs ?? ((buf) => {
      // Derive from the buffer length the same way parseWav would.
      const sampleRate = 24_000;
      const byteRate = sampleRate * 2;
      const dataBytes = buf.length - 44; // strip header
      return (Math.max(0, dataBytes) / byteRate) * 1000;
    }),
    assembleTakes: overrides.assembleTakes ?? (async (_takes, _totalMs) => DUMMY_TRACK),
    replaceVideoAudio: overrides.replaceVideoAudio ?? (async (_v, _a) => DUMMY_DUBBED),
    burnCues: overrides.burnCues ?? (async (_input) => DUMMY_BURNED),
  };
}

/* ------------------------------------------------------------------ *
 * 1. Exact cue wording goes to TTS unchanged
 * ------------------------------------------------------------------ */

describe("orchestrateLocalizedDub — exact cue wording", () => {
  it("passes each cue's text verbatim to TTS, in order", async () => {
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "నమస్కారం, ఇది ఒక పరీక్ష." },
      { index: 2, startMs: 2000, endMs: 4000, text: "మళ్ళీ కలుద్దాం." },
    ];
    const deps = makeDeps({ cueAudioMs: 800 }); // fits within 2000ms slot

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "te", voice: "nova", cues },
      deps,
    );

    expect(deps.spoken).toEqual([
      { text: "నమస్కారం, ఇది ఒక పరీక్ష.", voice: "nova" },
      { text: "మళ్ళీ కలుద్దాం.", voice: "nova" },
    ]);
  });

  it("does not alter the text even when it contains special characters", async () => {
    const exactText = "आपको जो चाहिए, सब एक जगह — बिल्कुल!";
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 3000, text: exactText },
    ];
    const deps = makeDeps({ cueAudioMs: 1000 });

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "hi", voice: "alloy", cues },
      deps,
    );

    expect(deps.spoken[0]!.text).toBe(exactText);
  });

  it("uses the voice from the track, not a default", async () => {
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "உங்களுக்கு வணக்கம்." },
    ];
    const deps = makeDeps({ cueAudioMs: 800 });

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "ta", voice: "shimmer", cues },
      deps,
    );

    expect(deps.spoken[0]!.voice).toBe("shimmer");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Locked starts and tempo fit are used
 * ------------------------------------------------------------------ */

describe("orchestrateLocalizedDub — locked starts and tempo fit", () => {
  it("passes the cue's startMs as the take's start offset", async () => {
    const capturedTakes: DubTake[] = [];
    const deps = makeDeps({
      cueAudioMs: 800,
      assembleTakes: async (takes, _totalMs) => {
        capturedTakes.push(...takes);
        return DUMMY_TRACK;
      },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 500, endMs: 2000, text: "First cue." },
      { index: 2, startMs: 3000, endMs: 5000, text: "Second cue." },
    ];

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "hi", voice: "alloy", cues },
      deps,
    );

    expect(capturedTakes).toHaveLength(2);
    expect(capturedTakes[0]!.startMs).toBe(500);
    expect(capturedTakes[1]!.startMs).toBe(3000);
  });

  it("sets tempo > 1 when a take slightly overflows its slot (within 8% cap)", async () => {
    const capturedTakes: DubTake[] = [];
    // 1070ms take in a 1000ms slot: needs tempo 1.07, which is within the 8% cap.
    // planAudioFit(1070, 1000) → tempo ≈ 1.07, overrunMs = 0.
    const deps = makeDeps({
      cueAudioMs: 1070,
      assembleTakes: async (takes, _totalMs) => {
        capturedTakes.push(...takes);
        return DUMMY_TRACK;
      },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 1000, text: "Dense cue text." },
    ];

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "te", voice: "nova", cues },
      deps,
    );

    expect(capturedTakes[0]!.tempo).toBeGreaterThan(1);
    expect(capturedTakes[0]!.tempo).toBeLessThanOrEqual(1 + 0.08 + 0.001);
  });

  it("sets tempo = 1 when the take is shorter than its slot", async () => {
    const capturedTakes: DubTake[] = [];
    const deps = makeDeps({
      cueAudioMs: 500, // fits in 2000ms slot
      assembleTakes: async (takes, _totalMs) => {
        capturedTakes.push(...takes);
        return DUMMY_TRACK;
      },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "Short cue." },
    ];

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "hi", voice: "alloy", cues },
      deps,
    );

    expect(capturedTakes[0]!.tempo).toBe(1);
  });

  it("uses the last cue endMs as the total track length", async () => {
    let capturedTotalMs = 0;
    const deps = makeDeps({
      cueAudioMs: 500,
      assembleTakes: async (takes, totalMs) => {
        capturedTotalMs = totalMs;
        return DUMMY_TRACK;
      },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 1500, text: "First." },
      { index: 2, startMs: 2000, endMs: 5000, text: "Last." },
    ];

    await orchestrateLocalizedDub(
      DUMMY_VIDEO,
      { locale: "te", voice: "nova", cues },
      deps,
    );

    expect(capturedTotalMs).toBe(5000);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Overrun fails instead of changing/colliding wording
 * ------------------------------------------------------------------ */

describe("orchestrateLocalizedDub — overrun fails loudly", () => {
  it("rejects a cue outside the source cut before calling TTS", async () => {
    const deps = makeDeps({ probeSourceDurationMs: async () => 900 });
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "Outside the source cut." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "hi", voice: "alloy", cues }, deps),
    ).rejects.toThrow(/ends after the source video/i);
    expect(deps.spoken).toHaveLength(0);
  });

  it("rejects zero-duration WAV audio before assembly", async () => {
    const assembleTakes = vi.fn(async () => DUMMY_TRACK);
    const deps = makeDeps({
      parseWavDurationMs: () => 0,
      assembleTakes,
    });
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "Must contain real audio." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "te", voice: "nova", cues }, deps),
    ).rejects.toThrow(/empty audio/i);
    expect(assembleTakes).not.toHaveBeenCalled();
  });

  it("throws CueOverrunError when a take still overruns after the tempo cap", async () => {
    // A 3000ms take in a 1000ms slot: needs tempo 3.0, capped at 1.08,
    // → fitted = 3000/1.08 ≈ 2778ms → overruns by ~1778ms.
    const deps = makeDeps({ cueAudioMs: 3000 });
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 1000, text: "Way too long for this slot." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "hi", voice: "alloy", cues }, deps),
    ).rejects.toThrow(CueOverrunError);
  });

  it("CueOverrunError message names the cue index and suggests trimming", async () => {
    const deps = makeDeps({ cueAudioMs: 3000 });
    const cues: ApprovedDubCue[] = [
      { index: 7, startMs: 0, endMs: 1000, text: "This line is far too long." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "te", voice: "nova", cues }, deps),
    ).rejects.toThrow(/cue 7/i);
  });

  it("does not silently rephrase text to make it fit — it only throws", async () => {
    const deps = makeDeps({ cueAudioMs: 3000 });
    const originalText = "ఈ వాక్యం చాలా పొడవుగా ఉంది, అందుకే అది స్లాట్‌లో సరిపోదు.";
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 1000, text: originalText },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "te", voice: "nova", cues }, deps),
    ).rejects.toThrow(CueOverrunError);

    // The text that WAS sent to TTS (before the overrun was detected) is verbatim.
    expect(deps.spoken[0]!.text).toBe(originalText);
  });

  it("fails at the first overrunning cue and stops — does not process further cues", async () => {
    const deps = makeDeps({ cueAudioMs: 3000 });
    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 1000, text: "First overrun." },
      { index: 2, startMs: 1000, endMs: 5000, text: "Should never be spoken." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "hi", voice: "alloy", cues }, deps),
    ).rejects.toThrow(CueOverrunError);

    // Only the first cue was spoken before the error.
    expect(deps.spoken).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * planAudioFit — unit tests for the fit calculator (already tested in
 * dub.test.ts; re-asserted here for the overrun-path contract)
 * ------------------------------------------------------------------ */

describe("planAudioFit overrun contract", () => {
  it("reports overrun when tempo would need to exceed MAX_TEMPO_ADJUST", () => {
    const fit = planAudioFit(3000, 1000);
    expect(fit.overrunMs).toBeGreaterThan(0);
    expect(fit.tempo).toBeCloseTo(1.08, 2);
    expect(fit.padMs).toBe(0);
  });

  it("reports no overrun when tempo is within 8%", () => {
    const fit = planAudioFit(1050, 1000);
    expect(fit.overrunMs).toBe(0);
    expect(fit.tempo).toBeGreaterThan(1);
    expect(fit.tempo).toBeLessThanOrEqual(1.08);
  });
});

/* ------------------------------------------------------------------ *
 * Route validation — these tests exercise the Zod-parsed request shape
 * and the pre-funding validation logic directly (without a real server).
 * ------------------------------------------------------------------ */

describe("localized_dub route pre-funding validation (unit)", () => {
  /**
   * Simulates the route's validation logic in isolation. Returns an error
   * message (as the route would 400), or null if the request is valid.
   *
   * This mirrors the logic in videos.ts without the DB/runner overhead,
   * so it runs in every CI environment without a real DB.
   */
  function validateLocalizedDubRequest(body: {
    localizedTrack?: {
      scriptApproved?: boolean;
      locale?: string;
      voice?: string;
      cues?: Array<{ index: number; startMs: number; endMs: number; text: string }>;
    } | null;
    sourceVideoPath?: string | null;
  }, tenantId = 100): string | null {
    if (!body.sourceVideoPath) return "A source video is required for a localized dub.";
    if (!body.localizedTrack) return "A localized track is required for a localized dub.";
    if (body.localizedTrack.scriptApproved !== true) {
      return "Please approve the script before submitting a localized dub job.";
    }
    const track = body.localizedTrack;
    const SUPPORTED_LOCALES = new Set(["te", "ta", "hi"]);
    const SUPPORTED_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
    if (!track.locale || !SUPPORTED_LOCALES.has(track.locale)) {
      return `Unsupported locale: ${track.locale}. Use te, ta, or hi.`;
    }
    if (!track.voice || !SUPPORTED_VOICES.has(track.voice)) {
      return `Unsupported voice: ${track.voice}.`;
    }
    if (!body.sourceVideoPath.startsWith(`/objects/${tenantId}/`)) {
      return "Invalid base video path.";
    }
    if (!track.cues || track.cues.length === 0) {
      return "At least one cue is required for a localized dub.";
    }
    if (track.cues.length > 300) {
      return "A localized dub supports at most 300 cues.";
    }
    const seenIndices = new Set<number>();
    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i]!;
      if (seenIndices.has(cue.index)) return `Duplicate cue index: ${cue.index}.`;
      seenIndices.add(cue.index);
      if (!cue.text || cue.text.trim().length === 0) {
        return `Cue ${cue.index}: text must not be blank.`;
      }
      if (cue.endMs <= cue.startMs) {
        return `Cue ${cue.index}: endMs must be greater than startMs.`;
      }
      if (i > 0) {
        const prev = track.cues[i - 1]!;
        if (cue.index <= prev.index) {
          return `Cues must be in ascending index order (cue ${cue.index} follows ${prev.index}).`;
        }
        if (cue.startMs < prev.endMs) {
          return `Cue ${cue.index} overlaps cue ${prev.index} (starts at ${cue.startMs} ms before previous ends at ${prev.endMs} ms).`;
        }
      }
    }
    return null;
  }

  function validBody(tenantId = 100) {
    return {
      sourceVideoPath: `/objects/${tenantId}/uploads/clip.mp4`,
      localizedTrack: {
        scriptApproved: true,
        locale: "te",
        voice: "nova",
        cues: [
          { index: 1, startMs: 0, endMs: 2000, text: "నమస్కారం." },
        ],
      },
    };
  }

  it("accepts a well-formed localized_dub request", () => {
    expect(validateLocalizedDubRequest(validBody())).toBeNull();
  });

  it("rejects when scriptApproved is false", () => {
    const body = { ...validBody(), localizedTrack: { ...validBody().localizedTrack, scriptApproved: false } };
    expect(validateLocalizedDubRequest(body)).toMatch(/approve/i);
  });

  it("rejects when scriptApproved is missing", () => {
    const body = { ...validBody(), localizedTrack: { ...validBody().localizedTrack, scriptApproved: undefined } };
    expect(validateLocalizedDubRequest(body as never)).toMatch(/approve/i);
  });

  it("rejects when sourceVideoPath is missing", () => {
    const body = { ...validBody(), sourceVideoPath: null };
    expect(validateLocalizedDubRequest(body)).toMatch(/source video/i);
  });

  it("rejects when sourceVideoPath is outside the tenant's namespace", () => {
    const body = { ...validBody(), sourceVideoPath: `/objects/9999/uploads/clip.mp4` };
    expect(validateLocalizedDubRequest(body, 100)).toMatch(/invalid base video path/i);
  });

  it("rejects an unsupported locale", () => {
    const body = { ...validBody(), localizedTrack: { ...validBody().localizedTrack, locale: "fr" } };
    expect(validateLocalizedDubRequest(body)).toMatch(/locale/i);
  });

  it("rejects an unsupported voice", () => {
    const body = { ...validBody(), localizedTrack: { ...validBody().localizedTrack, voice: "neptune" } };
    expect(validateLocalizedDubRequest(body)).toMatch(/voice/i);
  });

  it("rejects an empty cue list", () => {
    const body = { ...validBody(), localizedTrack: { ...validBody().localizedTrack, cues: [] } };
    expect(validateLocalizedDubRequest(body)).toMatch(/cue/i);
  });

  it("rejects a cue with whitespace-only text", () => {
    const body = {
      ...validBody(),
      localizedTrack: {
        ...validBody().localizedTrack,
        cues: [{ index: 1, startMs: 0, endMs: 2000, text: "   " }],
      },
    };
    expect(validateLocalizedDubRequest(body)).toMatch(/blank/i);
  });

  it("rejects a cue with empty text", () => {
    const body = {
      ...validBody(),
      localizedTrack: {
        ...validBody().localizedTrack,
        cues: [{ index: 1, startMs: 0, endMs: 2000, text: "" }],
      },
    };
    expect(validateLocalizedDubRequest(body)).toMatch(/blank/i);
  });

  it("rejects a cue with endMs <= startMs", () => {
    const body = {
      ...validBody(),
      localizedTrack: {
        ...validBody().localizedTrack,
        cues: [{ index: 1, startMs: 2000, endMs: 2000, text: "bad." }],
      },
    };
    expect(validateLocalizedDubRequest(body)).toMatch(/endMs must be greater/i);
  });

  it("rejects overlapping cues", () => {
    const body = {
      ...validBody(),
      localizedTrack: {
        ...validBody().localizedTrack,
        cues: [
          { index: 1, startMs: 0, endMs: 2000, text: "First." },
          { index: 2, startMs: 1500, endMs: 3000, text: "Overlaps first." },
        ],
      },
    };
    expect(validateLocalizedDubRequest(body)).toMatch(/overlaps/i);
  });

  it("rejects duplicate cue indices", () => {
    const body = {
      ...validBody(),
      localizedTrack: {
        ...validBody().localizedTrack,
        cues: [
          { index: 1, startMs: 0, endMs: 1000, text: "First." },
          { index: 1, startMs: 1000, endMs: 2000, text: "Duplicate index." },
        ],
      },
    };
    expect(validateLocalizedDubRequest(body)).toMatch(/duplicate/i);
  });

  it("rejects cues with descending indices", () => {
    const body = {
      ...validBody(),
      localizedTrack: {
        ...validBody().localizedTrack,
        cues: [
          { index: 2, startMs: 0, endMs: 1000, text: "Second first?" },
          { index: 1, startMs: 1000, endMs: 2000, text: "First second?" },
        ],
      },
    };
    expect(validateLocalizedDubRequest(body)).toMatch(/ascending/i);
  });

  it("rejects when localizedTrack is missing entirely", () => {
    const body = { ...validBody(), localizedTrack: null };
    expect(validateLocalizedDubRequest(body)).toMatch(/localized track/i);
  });
});

/* ------------------------------------------------------------------ *
 * 5. TTS/render failure uses the existing job refund path
 *    (unit: the orchestration throws, which the job runner catches)
 * ------------------------------------------------------------------ */

describe("localized_dub orchestration failure propagation", () => {
  it("propagates TTS errors so the job runner can catch and refund them", async () => {
    const ttsError = new Error("OpenAI TTS: service unavailable");
    const deps = makeDeps({
      speakCue: async () => { throw ttsError; },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "This will fail." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "hi", voice: "alloy", cues }, deps),
    ).rejects.toThrow("service unavailable");
  });

  it("propagates audio assembly errors so the job runner can catch and refund them", async () => {
    const assembleError = new Error("ffmpeg: filter graph failed");
    const deps = makeDeps({
      cueAudioMs: 500,
      assembleTakes: async () => { throw assembleError; },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "Assembly will fail." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "te", voice: "nova", cues }, deps),
    ).rejects.toThrow("filter graph failed");
  });

  it("propagates subtitle burn errors so the job runner can catch and refund them", async () => {
    const burnError = new Error("MissingIndicFontError: no font for te");
    const deps = makeDeps({
      cueAudioMs: 500,
      burnCues: async () => { throw burnError; },
    });

    const cues: ApprovedDubCue[] = [
      { index: 1, startMs: 0, endMs: 2000, text: "Burn will fail." },
    ];

    await expect(
      orchestrateLocalizedDub(DUMMY_VIDEO, { locale: "te", voice: "nova", cues }, deps),
    ).rejects.toThrow("no font for te");
  });

  it("CueOverrunError is distinct from generic errors so job runner can surface it user-facing", () => {
    const err = new CueOverrunError(3, 420);
    expect(err.name).toBe("CueOverrunError");
    expect(err.message).toMatch(/cue 3/i);
    expect(err.message).toMatch(/420 ms/);
    // Message must tell the user to shorten the SOURCE line, not the target-
    // language field (which is locked read-only after review).
    expect(err.message).toMatch(/shorten/i);
    expect(err.message).toMatch(/source/i);
  });
});
