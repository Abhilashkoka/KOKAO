import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// Radix components need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockState: {
  kits: any[];
  voiceStatus: any;
  cloneCalls: any[];
  removeCalls: any[];
  uploadUrlCalls: any[];
  extractCalls: any[];
  deleteExtractedCalls: any[];
  stockPreviewCalls: any[];
  clonePromise: Promise<any> | null;
} = {
  kits: [],
  voiceStatus: { enabled: true, configured: true, provider: "elevenlabs" },
  cloneCalls: [],
  removeCalls: [],
  uploadUrlCalls: [],
  extractCalls: [],
  deleteExtractedCalls: [],
  stockPreviewCalls: [],
  clonePromise: null,
};

/**
 * jsdom has no Web Audio API. Tests that exercise the pre-upload sample check
 * install this fake and configure the decoded result via `fakeAudio`. When
 * `fakeAudio` is null, decoding rejects — the check must then let the upload
 * proceed (analysis failures never block).
 */
let fakeAudio: { duration: number; amplitude: number; noiseFloor?: number; echoTail?: number } | null = null;
class FakeAudioContext {
  async decodeAudioData(_buf: ArrayBuffer) {
    if (!fakeAudio) throw new Error("undecodable");
    const { duration, amplitude, noiseFloor = 0, echoTail } = fakeAudio;
    const data = new Float32Array(1000);
    if (echoTail !== undefined) {
      // Simulate a reverberant room: produce repeating blocks of 10 windows
      // (20 samples each, matching WINDOW_COUNT=50) where 7 windows are loud
      // and the trailing 3 are at amplitude×echoTail.  This creates 5
      // qualifying loud→medium transitions across the 50-window scan — enough
      // to exceed VOICE_SAMPLE_ECHO_MIN_TRANSITIONS and flag as echoey.
      const samplesPerWindow = 20; // 1000 samples / 50 windows
      for (let w = 0; w < 50; w++) {
        const blockPos = w % 10;
        const level = blockPos < 7 ? amplitude : amplitude * echoTail;
        data.fill(level, w * samplesPerWindow, (w + 1) * samplesPerWindow);
      }
    } else {
      // Non-constant waveform shaped like speech: 80% "speech" at `amplitude`,
      // then 20% "pauses" at `noiseFloor` (silence by default).
      data.fill(amplitude, 0, 800);
      data.fill(noiseFloor, 800);
    }
    return { duration, getChannelData: () => data } as unknown as AudioBuffer;
  }
  async close() {}
}

function makeAudioFile() {
  const file = new File([new Uint8Array(64)], "sample.wav", { type: "audio/wav" });
  if (typeof file.arrayBuffer !== "function") {
    (file as any).arrayBuffer = async () => new ArrayBuffer(64);
  }
  return file;
}

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({ data: mockState.kits, isLoading: false }),
    useGetBrandVoiceStatus: () => ({ data: mockState.voiceStatus, isLoading: false }),
    useCloneBrandVoice: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(async (vars: any) => {
        mockState.cloneCalls.push(vars);
        if (mockState.clonePromise) return await mockState.clonePromise;
        return { activeVersion: { payload: null } };
      }),
    }),
    useRequestUploadUrl: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(async (vars: any) => {
        mockState.uploadUrlCalls.push(vars);
        return { uploadURL: "https://upload.example/put", objectPath: "/objects/sample" };
      }),
    }),
    useExtractBrandBaseVideoAudio: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(async (vars: any) => {
        mockState.extractCalls.push(vars);
        return {
          sampleAssetPath: "/objects/7/voice-extracts/7/founder-audio",
          contentType: "audio/mpeg",
          sizeBytes: 128_000,
          issues: [],
        };
      }),
    }),
    useDeleteBrandVoiceExtractedSample: () => ({
      ...idleMutation(),
      mutate: vi.fn((vars: any) => {
        mockState.deleteExtractedCalls.push(vars);
      }),
    }),
    usePreviewStockBrandVoice: () => ({
      ...idleMutation(),
      mutate: vi.fn((vars: any, opts: any) => {
        mockState.stockPreviewCalls.push(vars);
        opts?.onSuccess?.({
          audioPath: "/objects/7/previews/stock-alloy.wav",
        });
      }),
    }),
    useRemoveBrandVoice: () => ({
      ...idleMutation(),
      mutate: vi.fn((vars: any, opts: any) => {
        mockState.removeCalls.push(vars);
        opts?.onSuccess?.({ activeVersion: { payload: null } });
      }),
    }),
  });
});

import { BrandKitsPage } from "./brand-kits";

function makeKit(brandVoice: any = null, baseVideos: any[] = []) {
  return {
    id: 7,
    name: "Acme",
    slug: "acme",
    brandType: "primary",
    isDefault: true,
    activeVersion: {
      id: 1,
      version: 1,
      payload: {
        identity: {
          brand_name: "Acme",
          brand_slug: "acme",
          tagline: "",
          description: "",
          industry: "",
          audience: [],
        },
        voice: { traits: [], dos: [], donts: [], caption_style: "", cta_style: "" },
        colors: { primary: [], secondary: [], neutral: [] },
        logos: { primary: null, secondary: null, icon_mark: null, favicon: null, usage_rules: [] },
        visual_style: {
          imagery_style: [],
          icon_style: "",
          illustration_style: "",
          motion_style: "",
        },
        brand_voice: brandVoice,
        base_videos: baseVideos,
      },
    },
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <BrandKitsPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function openVoiceTab() {
  fireEvent.click(screen.getByTestId("button-edit-kit-7"));
  const voiceTab = await screen.findByRole("tab", { name: "Voice" });
  fireEvent.mouseDown(voiceTab);
  fireEvent.click(voiceTab);
  await screen.findByTestId("section-brand-voice");
}

describe("Brand Voice section in the Brand Kit editor", () => {
  beforeEach(() => {
    cleanup();
    mockState.kits = [makeKit()];
    mockState.voiceStatus = { enabled: true, configured: true, provider: "elevenlabs" };
    mockState.cloneCalls = [];
    mockState.removeCalls = [];
    mockState.uploadUrlCalls = [];
    mockState.extractCalls = [];
    mockState.deleteExtractedCalls = [];
    mockState.stockPreviewCalls = [];
    mockState.clonePromise = null;
    fakeAudio = null;
    (window as any).AudioContext = FakeAudioContext;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    // jsdom has no object-URL support; the review player needs one.
    (URL as any).createObjectURL = vi.fn(() => "blob:fake-take");
    (URL as any).revokeObjectURL = vi.fn();
  });

  /** A picked file now opens the review dialog; this listens + saves it. */
  async function saveTake() {
    await screen.findByTestId("audio-recorded-take");
    fireEvent.click(screen.getByTestId("button-save-voice-take"));
  }

  it("offers the sample upload and stock voice picker when no voice is cloned", async () => {
    renderPage();
    await openVoiceTab();

    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("select-preset-voice")).toBeTruthy();
    expect(screen.getByTestId("input-delivery-style")).toBeTruthy();
    expect(screen.getByTestId("button-preview-stock-voice")).toBeTruthy();
    expect(screen.queryByTestId("button-preview-brand-voice")).toBeNull();
  });

  it("plays a sample of the selected stock voice without cloning", async () => {
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-preview-stock-voice"));

    await waitFor(() => expect(mockState.stockPreviewCalls).toHaveLength(1));
    expect(mockState.stockPreviewCalls[0]).toEqual({
      id: 7,
      data: { presetVoice: "alloy" },
    });
    const audio = await screen.findByTestId("audio-stock-voice-preview");
    expect(audio.getAttribute("src")).toBe(
      "/api/storage/objects/7/previews/stock-alloy.wav",
    );
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("shows preview/replace/remove actions once a voice is cloned", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-1",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_at: "2026-08-01T00:00:00.000Z",
      }),
    ];
    renderPage();
    await openVoiceTab();

    // Named in the badge and again in the saved-voice library row.
    expect(screen.getAllByText("Founder voice").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("button-preview-brand-voice")).toBeTruthy();
    expect(screen.getByTestId("button-replace-brand-voice")).toBeTruthy();
    expect(screen.getByTestId("button-remove-brand-voice")).toBeTruthy();
  });

  it("reviews a saved base video's audio and clones it through the existing flow", async () => {
    mockState.kits = [
      makeKit(null, [
        {
          id: "base-founder",
          label: "Founder intro",
          video_path: "/objects/7/uploads/founder-video",
          voice_mode: "preset",
          preset_voice: "alloy",
        },
      ]),
    ];
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-extract-base-video-audio-base-founder"));

    const player = await screen.findByTestId("audio-recorded-take");
    expect((player as HTMLAudioElement).src).toContain(
      "/api/storage/objects/7/voice-extracts/7/founder-audio",
    );
    expect(mockState.extractCalls[0]).toEqual({
      id: 7,
      baseVideoId: "base-founder",
    });
    expect(mockState.uploadUrlCalls).toHaveLength(0);

    fireEvent.change(screen.getByTestId("input-voice-name"), {
      target: { value: "Founder from video" },
    });
    fireEvent.click(screen.getByTestId("select-voice-accent"));
    fireEvent.click(await screen.findByRole("option", { name: "Indian English" }));
    fireEvent.click(screen.getByTestId("button-save-voice-take"));

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(mockState.cloneCalls[0]).toMatchObject({
      id: 7,
      data: {
        sampleAssetPath: "/objects/7/voice-extracts/7/founder-audio",
        label: "Founder from video",
        accent: "indian_english",
      },
    });
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.deleteExtractedCalls).toHaveLength(0);
  });

  it("deletes the temporary extracted audio when the review is cancelled", async () => {
    mockState.kits = [
      makeKit(null, [
        {
          id: "base-founder",
          label: "Founder intro",
          video_path: "/objects/7/uploads/founder-video",
          voice_mode: "preset",
          preset_voice: "alloy",
        },
      ]),
    ];
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-extract-base-video-audio-base-founder"));
    await screen.findByTestId("audio-recorded-take");
    fireEvent.click(screen.getByTestId("button-cancel-extracted-voice"));

    await waitFor(() => expect(mockState.deleteExtractedCalls).toHaveLength(1));
    expect(mockState.deleteExtractedCalls[0]).toEqual({
      id: 7,
      data: {
        sampleAssetPath: "/objects/7/voice-extracts/7/founder-audio",
      },
    });
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("keeps an extracted sample locked in review while its clone is being saved", async () => {
    let resolveClone!: (value: any) => void;
    mockState.clonePromise = new Promise((resolve) => {
      resolveClone = resolve;
    });
    mockState.kits = [
      makeKit(null, [
        {
          id: "base-founder",
          label: "Founder intro",
          video_path: "/objects/7/uploads/founder-video",
          voice_mode: "preset",
          preset_voice: "alloy",
        },
      ]),
    ];
    renderPage();
    await openVoiceTab();
    fireEvent.click(screen.getByTestId("button-extract-base-video-audio-base-founder"));
    const dialog = await screen.findByTestId("dialog-record-voice");
    fireEvent.click(screen.getByTestId("button-save-voice-take"));
    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByTestId("dialog-record-voice")).toBeTruthy();
    expect(mockState.deleteExtractedCalls).toHaveLength(0);

    await act(async () => {
      resolveClone({ activeVersion: { payload: null } });
      await mockState.clonePromise;
    });
    await waitFor(() =>
      expect(screen.queryByTestId("dialog-record-voice")).toBeNull(),
    );
    expect(mockState.deleteExtractedCalls).toHaveLength(0);
  });

  it("labels an Indian English clone and explains how to change old recordings", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-indian",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_accent: "indian_english",
        cloned_at: "2026-08-01T00:00:00.000Z",
        voices: [
          {
            id: "voice-indian",
            label: "Founder voice",
            provider: "elevenlabs",
            provider_voice_id: "el-indian",
            sample_asset_path: "/objects/x",
            accent: "indian_english",
            cloned_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    ];
    renderPage();
    await openVoiceTab();

    expect(screen.getAllByText(/Indian English/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("text-voice-accent-guidance").textContent).toContain(
      "create a new clone",
    );
  });

  it("explains when the feature is switched off and blocks cloning", async () => {
    mockState.voiceStatus = { enabled: false, configured: true, provider: "elevenlabs" };
    renderPage();
    await openVoiceTab();

    expect(screen.getByTestId("text-brand-voice-disabled")).toBeTruthy();
    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains when no provider key is configured", async () => {
    mockState.voiceStatus = { enabled: true, configured: false, provider: "elevenlabs" };
    renderPage();
    await openVoiceTab();

    expect(screen.getByTestId("text-brand-voice-unconfigured")).toBeTruthy();
    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes the voice through the in-app confirm dialog", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-1",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_at: "2026-08-01T00:00:00.000Z",
      }),
    ];
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-remove-brand-voice"));
    fireEvent.click(await screen.findByTestId("button-confirm-remove-voice"));

    await waitFor(() => expect(mockState.removeCalls).toHaveLength(1));
    expect(mockState.removeCalls[0]).toMatchObject({ id: 7 });
  });

  it("opens the recording script dialog before a voice is cloned and copies the script", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-recording-script"));
    const dialog = await screen.findByTestId("dialog-recording-script");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("text-recording-script").textContent).toContain(
      "Have you ever noticed",
    );
    expect(screen.getByTestId("list-recording-tips").textContent).toContain("quiet room");

    fireEvent.click(screen.getByTestId("button-copy-recording-script"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("March 3rd, 2025");
    await screen.findByText("Copied!");
  });

  it("shows the script button next to Replace sample once a voice is cloned", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-1",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_at: "2026-08-01T00:00:00.000Z",
      }),
    ];
    renderPage();
    await openVoiceTab();

    expect(screen.getByTestId("button-replace-brand-voice")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-recording-script"));
    expect(await screen.findByTestId("dialog-recording-script")).toBeTruthy();
  });

  it("warns before uploading a too-short sample and cancels without cloning", async () => {
    fakeAudio = { duration: 8, amplitude: 0.2 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    const dialog = await screen.findByTestId("dialog-voice-sample-warning");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "shorter than 20 seconds",
    );

    fireEvent.click(screen.getByTestId("button-cancel-voice-sample"));
    await waitFor(() =>
      expect(screen.queryByTestId("dialog-voice-sample-warning")).toBeNull(),
    );
    expect(mockState.cloneCalls).toHaveLength(0);
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("lets the user upload anyway from the warning dialog", async () => {
    fakeAudio = { duration: 8, amplitude: 0.2 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();
    await screen.findByTestId("dialog-voice-sample-warning");
    fireEvent.click(screen.getByTestId("button-upload-voice-sample-anyway"));

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(mockState.cloneCalls[0]).toMatchObject({
      id: 7,
      data: { sampleAssetPath: "/objects/sample" },
    });
  });

  it("warns about a nearly silent sample", async () => {
    fakeAudio = { duration: 45, amplitude: 0.001 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await screen.findByTestId("dialog-voice-sample-warning");
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "very quiet",
    );
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("warns about an over-long sample", async () => {
    fakeAudio = { duration: 240, amplitude: 0.2 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await screen.findByTestId("dialog-voice-sample-warning");
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "longer than 90 seconds",
    );
  });

  it("warns about a clipped/distorted sample", async () => {
    fakeAudio = { duration: 45, amplitude: 0.999 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await screen.findByTestId("dialog-voice-sample-warning");
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "too loud",
    );
    expect(mockState.cloneCalls).toHaveLength(0);
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("warns about heavy background noise in the pauses", async () => {
    fakeAudio = { duration: 45, amplitude: 0.2, noiseFloor: 0.1 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await screen.findByTestId("dialog-voice-sample-warning");
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "background noise",
    );
    expect(mockState.cloneCalls).toHaveLength(0);
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("lets the user upload a noisy sample anyway", async () => {
    fakeAudio = { duration: 45, amplitude: 0.2, noiseFloor: 0.1 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();
    await screen.findByTestId("dialog-voice-sample-warning");
    fireEvent.click(screen.getByTestId("button-upload-voice-sample-anyway"));

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
  });

  it("warns about a reverberant (echoey) room", async () => {
    // echoTail=0.6 → trailing windows at 60% of speech amplitude: slow decay
    fakeAudio = { duration: 45, amplitude: 0.2, echoTail: 0.6 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await screen.findByTestId("dialog-voice-sample-warning");
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "echoey",
    );
    expect(mockState.cloneCalls).toHaveLength(0);
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("lets the user upload an echoey sample anyway", async () => {
    fakeAudio = { duration: 45, amplitude: 0.2, echoTail: 0.6 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();
    await screen.findByTestId("dialog-voice-sample-warning");
    fireEvent.click(screen.getByTestId("button-upload-voice-sample-anyway"));

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
  });

  it("does not flag a sample with a quiet noise floor as noisy", async () => {
    fakeAudio = { duration: 45, amplitude: 0.2, noiseFloor: 0.005 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(screen.queryByTestId("dialog-voice-sample-warning")).toBeNull();
  });

  it("does not flag a loud-but-clean sample as clipped", async () => {
    fakeAudio = { duration: 45, amplitude: 0.9 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(screen.queryByTestId("dialog-voice-sample-warning")).toBeNull();
  });

  it("uploads a good sample directly with no warning", async () => {
    fakeAudio = { duration: 45, amplitude: 0.2 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(screen.queryByTestId("dialog-voice-sample-warning")).toBeNull();
  });

  it("still uploads when the sample can't be decoded for analysis", async () => {
    fakeAudio = null; // decodeAudioData rejects
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });
    await saveTake();

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(screen.queryByTestId("dialog-voice-sample-warning")).toBeNull();
  });

  it("keeps the script dialog available when cloning is disabled", async () => {
    mockState.voiceStatus = { enabled: false, configured: true, provider: "elevenlabs" };
    renderPage();
    await openVoiceTab();

    const btn = screen.getByTestId("button-recording-script") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(await screen.findByTestId("dialog-recording-script")).toBeTruthy();
  });
});
