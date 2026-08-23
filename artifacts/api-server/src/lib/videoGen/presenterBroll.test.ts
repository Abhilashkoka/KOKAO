import { beforeEach, describe, expect, it, vi } from "vitest";

const resolverState = vi.hoisted(() => ({ downloads: 0 }));

vi.mock("./topicVideo/stockSources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./topicVideo/stockSources")>();
  return {
    ...actual,
    stockCandidates: vi.fn(async () => [
      { def: { id: "pexels", label: "Pexels" }, apiKey: "test-key" },
    ]),
    searchStockClips: vi.fn(async () => [
      {
        id: "clip-1",
        url: "https://video.example.test/clip-1.mp4",
        width: 720,
        height: 1280,
        provider: "pexels",
      },
    ]),
    downloadStockClip: vi.fn(async () => {
      resolverState.downloads += 1;
      return Buffer.from("stock-video");
    }),
  };
});

vi.mock("./slideshow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slideshow")>()),
  extractPosterFrame: vi.fn(async () => Buffer.from("poster-image")),
}));

import {
  alignPresenterNarration,
  presenterStoryboard,
  proportionalNarrationLines,
  resolvePresenterBrollAssets,
  syncReviewedPresenterBroll,
  type PresenterBrollSnapshot,
} from "./presenterBroll";
import { videoJobUnits } from "./units";

const snapshot = (): PresenterBrollSnapshot => ({
  version: 1,
  durationMs: 10_000,
  lines: [
    { index: 1, startMs: 0, endMs: 5_000, text: "Open with the customer problem." },
    { index: 2, startMs: 5_000, endMs: 10_000, text: "Close with one clear action." },
  ],
  beats: [
    {
      id: "pb1",
      startMs: 0,
      endMs: 5_000,
      query: "customer reviewing a weekly planner",
      kind: "lifestyle",
      opacity: 0.55,
      lineIndexes: [1],
      assetPath: "/objects/7/uploads/weekly-planner.mp4",
      previewPath: "/objects/7/uploads/weekly-planner-poster.png",
      assetKind: "video",
      provider: "pexels",
    },
  ],
  notes: [],
});

beforeEach(() => {
  resolverState.downloads = 0;
});

describe("proportionalNarrationLines", () => {
  it("covers the presenter duration exactly and weights sentence time by words", () => {
    const lines = proportionalNarrationLines(
      "Short opening. This closing sentence contains substantially more spoken words.",
      12_000,
    );
    expect(lines[0]?.startMs).toBe(0);
    expect(lines.at(-1)?.endMs).toBe(12_000);
    expect(lines[1]!.endMs - lines[1]!.startMs).toBeGreaterThan(
      lines[0]!.endMs - lines[0]!.startMs,
    );
  });

  it("splits a single long sentence so captions still advance over time", () => {
    const lines = proportionalNarrationLines(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
      14_000,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.index)).toEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1),
    );
  });

  it("pins the submitted script chunks to matching ASR speech segments", () => {
    const lines = alignPresenterNarration({
      script: "Plan one clear priority. Review that priority every morning.",
      transcriptText:
        "Plan one clear priority. Review that priority every morning.",
      durationMs: 10_000,
      segments: [
        { startMs: 500, endMs: 4_000, text: "Plan one clear priority." },
        {
          startMs: 5_000,
          endMs: 9_500,
          text: "Review that priority every morning.",
        },
      ],
    });
    expect(lines).toMatchObject([
      { text: "Plan one clear priority.", startMs: 500, endMs: 4_000 },
      {
        text: "Review that priority every morning.",
        startMs: 5_000,
        endMs: 9_500,
      },
    ]);
  });

  it("rejects a script that does not match the presenter's spoken take", () => {
    expect(() =>
      alignPresenterNarration({
        script: "Plan one clear priority and review it every morning.",
        transcriptText: "Welcome to our completely unrelated summer travel guide.",
        durationMs: 10_000,
        segments: [
          {
            startMs: 0,
            endMs: 9_000,
            text: "Welcome to our completely unrelated summer travel guide.",
          },
        ],
      }),
    ).toThrow(/does not closely match/i);
  });
});

describe("presenter storyboard snapshots", () => {
  it("keeps presenter timing locked and exposes only editable B-roll queries", () => {
    expect(presenterStoryboard(snapshot())).toMatchObject({
      presenterBroll: true,
      visualsSource: "prompt",
      timelineLocked: true,
      narration: null,
      scenes: [
        {
          id: "pb1",
          text: "",
          visual: "customer reviewing a weekly planner",
          durationSec: 5,
          previewPath: "/objects/7/uploads/weekly-planner-poster.png",
        },
      ],
    });
  });

  it("prices generated presenter B-roll from the persisted bounded beat count", () => {
    const planned = snapshot();
    planned.beats = Array.from({ length: 4 }, (_, index) => ({
      ...planned.beats[0]!,
      id: `pb${index + 1}`,
      assetPath: null,
      previewPath: null,
    }));
    expect(
      videoJobUnits("topic_to_video", {
        aspectRatio: "9:16",
        presenterVideoPath: "/objects/7/uploads/presenter.mp4",
        visualsSource: "ai_video",
        presenterBroll: planned,
        musicPrompt: null,
      }),
    ).toBe(4);
    expect(
      videoJobUnits("topic_to_video", {
        aspectRatio: "9:16",
        presenterVideoPath: "/objects/7/uploads/presenter.mp4",
        visualsSource: "ai",
        presenterBroll: planned,
        musicPrompt: "light ambient bed",
      }),
    ).toBe(5);
  });

  it("reuses already-resolved assets when review made no visual changes", async () => {
    const planned = snapshot();
    const upload = vi.fn(async () => {
      throw new Error("unchanged review must not generate or upload again");
    });
    await expect(
      syncReviewedPresenterBroll({
        snapshot: planned,
        storyboard: presenterStoryboard(planned),
        aspectRatio: "9:16",
        visualsSource: "stock",
        stockSource: "auto",
        upload,
        load: vi.fn(),
        onStage: vi.fn(),
      }),
    ).resolves.toBe(planned);
    expect(upload).not.toHaveBeenCalled();
  });

  it("resumes poster creation from a checkpoint without resolving the asset again", async () => {
    const pending = snapshot();
    pending.beats[0]!.assetPath = null;
    pending.beats[0]!.previewPath = null;
    pending.beats[0]!.provider = null;
    const checkpoints: PresenterBrollSnapshot[] = [];
    const firstUpload = vi
      .fn<(bytes: Buffer, contentType: string) => Promise<string>>()
      .mockResolvedValueOnce("/objects/7/uploads/broll.mp4")
      .mockRejectedValueOnce(new Error("poster upload failed"));

    await expect(
      resolvePresenterBrollAssets({
        snapshot: pending,
        aspectRatio: "9:16",
        visualsSource: "stock",
        stockSource: "auto",
        upload: firstUpload,
        load: vi.fn(),
        onStage: vi.fn(),
        onCheckpoint: async (value) => {
          checkpoints.push(structuredClone(value));
        },
      }),
    ).rejects.toThrow("poster upload failed");

    expect(resolverState.downloads).toBe(1);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.beats[0]).toMatchObject({
      assetPath: "/objects/7/uploads/broll.mp4",
      previewPath: null,
      provider: "pexels",
    });

    const load = vi.fn(async () => Buffer.from("saved-stock-video"));
    const resumed = await resolvePresenterBrollAssets({
      snapshot: checkpoints[0]!,
      aspectRatio: "9:16",
      visualsSource: "stock",
      stockSource: "auto",
      upload: vi.fn(async () => "/objects/7/uploads/broll-poster.png"),
      load,
      onStage: vi.fn(),
      onCheckpoint: async () => {},
    });

    expect(resolverState.downloads).toBe(1);
    expect(load).toHaveBeenCalledWith("/objects/7/uploads/broll.mp4");
    expect(resumed.beats[0]!.previewPath).toBe(
      "/objects/7/uploads/broll-poster.png",
    );
  });
});