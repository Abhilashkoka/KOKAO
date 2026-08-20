import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { splitIntoSentences, parseWav, buildWav, synthesizeNarration } from "./narration";
import { wrapSubtitleText, sceneDurations, composeTopicVideo } from "./compose";
import { buildTopicScriptPrompt, cleanScript } from "./script";
import { searchStockClips, downloadStockClip, STOCK_SOURCES } from "./stockSources";
import { runFfmpeg } from "../slideshow";

// ---------------------------------------------------------------------------
// Sentence splitting

describe("splitIntoSentences", () => {
  it("splits on sentence punctuation and keeps the terminator", () => {
    const out = splitIntoSentences(
      "First things first. Then comes the second part! Are you ready for it?",
    );
    expect(out).toEqual([
      "First things first.",
      "Then comes the second part!",
      "Are you ready for it?",
    ]);
  });

  it("merges tiny fragments so no subtitle flashes by", () => {
    const out = splitIntoSentences("Wow. That was a truly unexpected turn of events today.");
    expect(out).toEqual(["Wow. That was a truly unexpected turn of events today."]);
  });

  it("splits very long sentences on commas", () => {
    const long =
      "The morning starts with a quiet stretch and a glass of water, followed by ten minutes of sunlight on the balcony, and only then does the phone come out of airplane mode for the day.";
    const out = splitIntoSentences(long);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });

  it("handles Devanagari sentence terminators", () => {
    const out = splitIntoSentences("यह पहला वाक्य है। यह दूसरा वाक्य है और थोड़ा लंबा है।");
    expect(out).toHaveLength(2);
  });

  it("returns empty for whitespace input", () => {
    expect(splitIntoSentences("   \n  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WAV parsing and construction

function makeTestWav(durationSec: number, sampleRate = 24_000): Buffer {
  const byteRate = sampleRate * 2; // mono pcm16
  const pcm = Buffer.alloc(Math.round(byteRate * durationSec));
  return buildWav(
    { channels: 1, sampleRate, bitsPerSample: 16, byteRate, blockAlign: 2 },
    pcm,
  );
}

describe("parseWav / buildWav", () => {
  it("round-trips and reports the correct duration", () => {
    const wav = makeTestWav(1.5);
    const parsed = parseWav(wav);
    expect(parsed.durationSec).toBeCloseTo(1.5, 2);
    expect(parsed.format.sampleRate).toBe(24_000);
    expect(parsed.format.channels).toBe(1);
  });

  it("rejects non-WAV bytes", () => {
    expect(() => parseWav(Buffer.from("definitely not audio data at all"))).toThrow(
      /unexpected audio/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Narration synthesis (TTS mocked)

vi.mock("@workspace/integrations-openai-ai-server/audio", () => ({
  textToSpeech: vi.fn(async () => makeTestWav(2)),
}));

describe("synthesizeNarration", () => {
  it("stitches sentences with gaps and accurate cue timings", async () => {
    const narration = await synthesizeNarration(
      ["First sentence here.", "Second sentence here."],
      "alloy",
    );
    expect(narration.cues).toHaveLength(2);
    expect(narration.cues[0]!.startSec).toBe(0);
    expect(narration.cues[0]!.endSec).toBeCloseTo(2, 1);
    // Second cue starts after the first sentence plus the inter-sentence gap.
    expect(narration.cues[1]!.startSec).toBeGreaterThan(2);
    // Total = 2 + gap + 2 + tail.
    expect(narration.totalDurationSec).toBeGreaterThan(4);
    // The stitched track is a valid WAV of the reported length.
    const parsed = parseWav(narration.wav);
    expect(parsed.durationSec).toBeCloseTo(narration.totalDurationSec, 1);
  });
});

// ---------------------------------------------------------------------------
// Re-recording an edited storyboard's narration

describe("refreshEditedNarration", () => {
  const board = (scenes: { id: string; text: string }[], cueTexts: string[]) => ({
    version: 1 as const,
    visualsSource: "character" as const,
    timelineLocked: true,
    model: null,
    provider: null,
    regenerations: 0,
    narration: {
      audioPath: "/objects/1/uploads/narration.wav",
      totalDurationSec: cueTexts.length * 2,
      cues: cueTexts.map((text, i) => ({ text, startSec: i * 2, endSec: i * 2 + 2 })),
    },
    scenes: scenes.map((s) => ({
      ...s,
      visual: s.text,
      durationSec: 2,
      previewPath: "/objects/1/uploads/still.png",
      outfitId: null,
    })),
  });

  it("returns null when the scene texts still match the recording", async () => {
    const { refreshEditedNarration } = await import("./index");
    const untouched = board(
      [
        { id: "s1", text: "First sentence here." },
        { id: "s2", text: "Second sentence here." },
      ],
      ["First sentence here.", "Second sentence here."],
    );
    expect(
      await refreshEditedNarration({
        storyboard: untouched,
        voice: "alloy",
        upload: async () => "/objects/1/uploads/new.wav",
      }),
    ).toBeNull();
  });

  it("re-voices edited scenes and recomputes their lengths from the new cues", async () => {
    const { refreshEditedNarration } = await import("./index");
    const edited = board(
      [
        { id: "s1", text: "A completely new opening line." },
        { id: "s2", text: "Second sentence here." },
      ],
      ["First sentence here.", "Second sentence here."],
    );
    const uploads: string[] = [];
    const refreshed = await refreshEditedNarration({
      storyboard: edited,
      voice: "alloy",
      upload: async (_bytes, contentType) => {
        uploads.push(contentType);
        return "/objects/1/uploads/re-recorded.wav";
      },
    });
    expect(refreshed).not.toBeNull();
    expect(uploads).toEqual(["audio/wav"]);
    expect(refreshed!.narration!.audioPath).toBe("/objects/1/uploads/re-recorded.wav");
    expect(refreshed!.narration!.cues.map((c) => c.text)).toEqual([
      "A completely new opening line.",
      "Second sentence here.",
    ]);
    // Scene lengths follow the new recording: every cue is a 2s mocked TTS
    // clip, so each scene owns roughly its clip plus the inter-sentence gap.
    const total = refreshed!.narration!.totalDurationSec;
    const summed = refreshed!.scenes.reduce((sum, s) => sum + s.durationSec, 0);
    expect(summed).toBeCloseTo(total, 1);
    // Stills and prompts are untouched — only the audio and timings moved.
    expect(refreshed!.scenes.map((s) => s.previewPath)).toEqual(
      edited.scenes.map((s) => s.previewPath),
    );
  });

  it("refuses to record a scene that has no words", async () => {
    const { refreshEditedNarration } = await import("./index");
    const blank = board(
      [
        { id: "s1", text: "   " },
        { id: "s2", text: "Second sentence here." },
      ],
      ["First sentence here.", "Second sentence here."],
    );
    await expect(
      refreshEditedNarration({
        storyboard: blank,
        voice: "alloy",
        upload: async () => "/objects/1/uploads/new.wav",
      }),
    ).rejects.toThrow(/no narration text/i);
  });
});

// ---------------------------------------------------------------------------
// Script prompt + cleanup

describe("script generation helpers", () => {
  it("builds a prompt carrying the topic and paragraph count", () => {
    const prompt = buildTopicScriptPrompt("street food of Hyderabad", 2);
    expect(prompt).toContain("street food of Hyderabad");
    expect(prompt).toContain("exactly 2 paragraphs");
    expect(prompt).toContain("searchTerms");
  });

  it("clamps the paragraph count into range", () => {
    expect(buildTopicScriptPrompt("x", 99)).toContain("exactly 3 paragraphs");
    expect(buildTopicScriptPrompt("x", 0)).toContain("exactly 1 paragraph");
  });

  it("injects a brand voice block only when a hint is supplied", () => {
    const plain = buildTopicScriptPrompt("morning chai", 1);
    expect(plain).not.toContain("Brand voice");
    const branded = buildTopicScriptPrompt(
      "morning chai",
      1,
      "Voice: warm, practical. Never use these terms: cheap.",
    );
    expect(branded).toContain("Brand voice");
    expect(branded).toContain("Voice: warm, practical. Never use these terms: cheap.");
    // Branding steers the voice; it must not change the output contract.
    expect(branded).toContain("exactly 1 paragraph");
    expect(branded).toContain("searchTerms");
  });

  it("injects a reference style block only when guidance is supplied", () => {
    const plain = buildTopicScriptPrompt("morning chai", 1);
    expect(plain).not.toContain("Reference style");
    const styled = buildTopicScriptPrompt(
      "morning chai",
      1,
      null,
      "Open the same way: question straight to camera. Pace the narration at roughly 160 words per minute.",
    );
    expect(styled).toContain("Reference style");
    expect(styled).toContain("question straight to camera");
    // Style steers structure; it must not change the output contract.
    expect(styled).toContain("exactly 1 paragraph");
    expect(styled).toContain("searchTerms");
  });

  it("carries a brand voice and a reference style together", () => {
    const both = buildTopicScriptPrompt(
      "morning chai",
      2,
      "Voice: warm, practical.",
      "Energy: punchy.",
    );
    expect(both).toContain("Brand voice");
    expect(both).toContain("Reference style");
    expect(both).toContain("exactly 2 paragraphs");
  });

  it("cleans markdown remnants out of a script", () => {
    expect(cleanScript("**Bold** start. [pause] The # real content.")).toBe(
      "Bold start.  The  real content.",
    );
  });
});

// ---------------------------------------------------------------------------
// Stock search (HTTP mocked)

const PEXELS_FIXTURE = {
  videos: [
    {
      duration: 12,
      video_files: [
        { link: "https://cdn.example/sd.mp4", width: 640, height: 360 },
        { link: "https://cdn.example/hd.mp4", width: 1080, height: 1920 },
        { link: "https://cdn.example/uhd.mp4", width: 2160, height: 3840 },
      ],
    },
    { duration: 1, video_files: [{ link: "https://cdn.example/short.mp4", width: 1080, height: 1920 }] },
    { duration: 8, video_files: [{ link: "https://cdn.example/tiny.mp4", width: 480, height: 854 }] },
  ],
};

describe("searchStockClips", () => {
  const pexels = STOCK_SOURCES.find((s) => s.id === "pexels")!;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(PEXELS_FIXTURE), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps only clips long enough with a rendition that covers the frame", async () => {
    const clips = await searchStockClips(pexels, "key", "sunrise", "9:16");
    // The 1s clip and the sub-720p-only clip are dropped.
    expect(clips).toHaveLength(1);
    // The 1080x1920 rendition is closest to the 9:16 target area (not the 4K one).
    expect(clips[0]!.url).toBe("https://cdn.example/hd.mp4");
    expect(clips[0]!.provider).toBe("pexels");
  });

  it("surfaces API errors as provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(searchStockClips(pexels, "bad-key", "sunrise", "9:16")).rejects.toThrow(
      /pexels search failed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Subtitle wrapping + scene timing

describe("wrapSubtitleText", () => {
  it("wraps on word boundaries", () => {
    expect(wrapSubtitleText("the quick brown fox jumps over the lazy dog", 15)).toBe(
      "the quick brown\nfox jumps over\nthe lazy dog",
    );
  });

  it("hard-splits words longer than a line", () => {
    const wrapped = wrapSubtitleText("Donaudampfschifffahrtsgesellschaft", 10);
    for (const line of wrapped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("sceneDurations", () => {
  it("extends every scene to the next cue and the last to the end", () => {
    const cues = [
      { text: "a", startSec: 0, endSec: 2 },
      { text: "b", startSec: 2.25, endSec: 4.25 },
    ];
    expect(sceneDurations(cues, 5)).toEqual([2.25, 2.75]);
  });
});

// ---------------------------------------------------------------------------
// Real-ffmpeg composition smoke test (same spirit as slideshow.test.ts)

async function makeTestClip(seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "topic-test-clip-"));
  try {
    await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=teal:s=320x568:d=${seconds}:r=30`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "clip.mp4",
      ],
      dir,
    );
    const { readFile } = await import("fs/promises");
    return await readFile(join(dir, "clip.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A tiny transparent-ish PNG to stand in for a brand logo. */
async function makeTestLogo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "topic-test-logo-"));
  try {
    await runFfmpeg(
      ["-y", "-f", "lavfi", "-i", "color=c=white:s=120x40:d=1", "-frames:v", "1", "logo.png"],
      dir,
    );
    const { readFile } = await import("fs/promises");
    return await readFile(join(dir, "logo.png"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("composeTopicVideo (real ffmpeg)", () => {
  it(
    "renders narrated, subtitled scenes into a single MP4",
    async () => {
      const clip = await makeTestClip(2);
      const cues = [
        { text: "First scene of the story.", startSec: 0, endSec: 1.4 },
        { text: "Second scene wraps it up.", startSec: 1.65, endSec: 3.05 },
      ];
      const wav = makeTestWav(3.6);
      const out = await composeTopicVideo({
        clips: [clip],
        narrationWav: wav,
        cues,
        totalDurationSec: 3.65,
        aspectRatio: "9:16",
        subtitles: true,
        music: null,
      });
      // MP4 magic: "ftyp" at offset 4.
      expect(out.toString("ascii", 4, 8)).toBe("ftyp");
      expect(out.length).toBeGreaterThan(1000);
    },
    120_000,
  );

  it(
    "renders dynamic word-group captions",
    async () => {
      const clip = await makeTestClip(2);
      const out = await composeTopicVideo({
        clips: [clip],
        narrationWav: makeTestWav(3.6),
        cues: [
          { text: "First scene of the story.", startSec: 0, endSec: 1.4 },
          { text: "Second scene wraps it up.", startSec: 1.65, endSec: 3.05 },
        ],
        totalDurationSec: 3.65,
        aspectRatio: "9:16",
        subtitles: true,
        captionStyle: "dynamic",
        music: null,
      });
      expect(out.toString("ascii", 4, 8)).toBe("ftyp");
      expect(out.length).toBeGreaterThan(1000);
    },
    120_000,
  );

  it(
    "loops a short source clip to cover a longer scene",
    async () => {
      const clip = await makeTestClip(1);
      const out = await composeTopicVideo({
        clips: [clip],
        narrationWav: makeTestWav(4),
        cues: [{ text: "One long take.", startSec: 0, endSec: 3.4 }],
        totalDurationSec: 4,
        aspectRatio: "1:1",
        subtitles: false,
        music: null,
      });
      expect(out.toString("ascii", 4, 8)).toBe("ftyp");
    },
    120_000,
  );

  it(
    "follows an explicit scene map (one clip spanning several cues)",
    async () => {
      const clipA = await makeTestClip(1);
      const clipB = await makeTestClip(1);
      const out = await composeTopicVideo({
        clips: [clipA, clipB],
        narrationWav: makeTestWav(4.5),
        cues: [
          { text: "First cue of scene one.", startSec: 0, endSec: 1.4 },
          { text: "Second cue, same scene.", startSec: 1.65, endSec: 2.4 },
          { text: "Scene two wraps it up.", startSec: 2.65, endSec: 4.05 },
        ],
        totalDurationSec: 4.65,
        aspectRatio: "9:16",
        subtitles: true,
        music: null,
        sceneMap: [
          { clipIndex: 0, durationSec: 2.65 },
          { clipIndex: 1, durationSec: 2.0 },
        ],
      });
      expect(out.toString("ascii", 4, 8)).toBe("ftyp");
    },
    120_000,
  );

  it(
    "renders brand accent captions and a corner logo watermark",
    async () => {
      const clip = await makeTestClip(2);
      const out = await composeTopicVideo({
        clips: [clip],
        narrationWav: makeTestWav(3.6),
        cues: [
          { text: "Branded scene one.", startSec: 0, endSec: 1.4 },
          { text: "Branded scene two.", startSec: 1.65, endSec: 3.05 },
        ],
        totalDurationSec: 3.65,
        aspectRatio: "9:16",
        subtitles: true,
        captionStyle: "dynamic",
        music: null,
        accentColor: "0x733D00",
        watermark: await makeTestLogo(),
      });
      expect(out.toString("ascii", 4, 8)).toBe("ftyp");
      expect(out.length).toBeGreaterThan(1000);
    },
    120_000,
  );

  it(
    "still renders when a watermark is supplied without subtitles or music",
    async () => {
      const out = await composeTopicVideo({
        clips: [await makeTestClip(2)],
        // loudnorm needs a few seconds of audio to settle (it emits NaN on
        // very short inputs), so keep test narration at 4s like the others.
        narrationWav: makeTestWav(4),
        cues: [{ text: "Logo only.", startSec: 0, endSec: 3.4 }],
        totalDurationSec: 4,
        aspectRatio: "1:1",
        subtitles: false,
        music: null,
        watermark: await makeTestLogo(),
      });
      expect(out.toString("ascii", 4, 8)).toBe("ftyp");
    },
    120_000,
  );

  it("rejects a scene map that points at a missing clip", async () => {
    await expect(
      composeTopicVideo({
        clips: [Buffer.from("x")],
        narrationWav: makeTestWav(1),
        cues: [{ text: "x", startSec: 0, endSec: 1 }],
        totalDurationSec: 1,
        aspectRatio: "9:16",
        subtitles: false,
        music: null,
        sceneMap: [{ clipIndex: 3, durationSec: 1 }],
      }),
    ).rejects.toThrow(/missing clip/i);
  });

  it("rejects an empty clip list", async () => {
    await expect(
      composeTopicVideo({
        clips: [],
        narrationWav: makeTestWav(1),
        cues: [{ text: "x", startSec: 0, endSec: 1 }],
        totalDurationSec: 1,
        aspectRatio: "9:16",
        subtitles: false,
        music: null,
      }),
    ).rejects.toThrow(/no stock footage/i);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard on stock clip downloads (URLs come from third-party responses)

describe("downloadStockClip SSRF guard", () => {
  const base = {
    durationSec: 5,
    width: 1920,
    height: 1080,
    provider: "pexels" as const,
    thumbnailUrl: null,
  };

  it("rejects non-https clip URLs", async () => {
    await expect(
      downloadStockClip({ ...base, url: "http://videos.pexels.com/clip.mp4" }),
    ).rejects.toThrow(/non-https/i);
  });

  it("rejects invalid clip URLs", async () => {
    await expect(downloadStockClip({ ...base, url: "not a url" })).rejects.toThrow(
      /invalid clip url/i,
    );
  });

  it("rejects localhost and private hosts", async () => {
    for (const url of [
      "https://localhost/clip.mp4",
      "https://127.0.0.1/clip.mp4",
      "https://10.0.0.5/clip.mp4",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/clip.mp4",
    ]) {
      await expect(downloadStockClip({ ...base, url })).rejects.toThrow(
        /blocked or private host/i,
      );
    }
  });

  it("re-validates redirect hops and blocks redirects into private ranges", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      }),
    ) as unknown as typeof fetch;
    try {
      await expect(
        downloadStockClip({ ...base, url: "https://videos.pexels.com/clip.mp4" }),
      ).rejects.toThrow(/blocked or private host/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
