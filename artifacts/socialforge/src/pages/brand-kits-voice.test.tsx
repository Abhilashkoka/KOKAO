import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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
} = {
  kits: [],
  voiceStatus: { enabled: true, configured: true, provider: "elevenlabs" },
  cloneCalls: [],
  removeCalls: [],
  uploadUrlCalls: [],
};

/**
 * jsdom has no Web Audio API. Tests that exercise the pre-upload sample check
 * install this fake and configure the decoded result via `fakeAudio`. When
 * `fakeAudio` is null, decoding rejects — the check must then let the upload
 * proceed (analysis failures never block).
 */
let fakeAudio: { duration: number; amplitude: number } | null = null;
class FakeAudioContext {
  async decodeAudioData(_buf: ArrayBuffer) {
    if (!fakeAudio) throw new Error("undecodable");
    const { duration, amplitude } = fakeAudio;
    const data = new Float32Array(1000).fill(amplitude);
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

function makeKit(brandVoice: any = null) {
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
    fakeAudio = null;
    (window as any).AudioContext = FakeAudioContext;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
  });

  it("offers the sample upload and stock voice picker when no voice is cloned", async () => {
    renderPage();
    await openVoiceTab();

    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("select-preset-voice")).toBeTruthy();
    expect(screen.getByTestId("input-delivery-style")).toBeTruthy();
    expect(screen.queryByTestId("button-preview-brand-voice")).toBeNull();
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

    expect(screen.getByText("Founder voice")).toBeTruthy();
    expect(screen.getByTestId("button-preview-brand-voice")).toBeTruthy();
    expect(screen.getByTestId("button-replace-brand-voice")).toBeTruthy();
    expect(screen.getByTestId("button-remove-brand-voice")).toBeTruthy();
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

    await screen.findByTestId("dialog-voice-sample-warning");
    expect(screen.getByTestId("text-voice-sample-warning").textContent).toContain(
      "too loud",
    );
    expect(mockState.cloneCalls).toHaveLength(0);
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("does not flag a loud-but-clean sample as clipped", async () => {
    fakeAudio = { duration: 45, amplitude: 0.9 };
    renderPage();
    await openVoiceTab();

    fireEvent.change(screen.getByTestId("input-voice-sample"), {
      target: { files: [makeAudioFile()] },
    });

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
