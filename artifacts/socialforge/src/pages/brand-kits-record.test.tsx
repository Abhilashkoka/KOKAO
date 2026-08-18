import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  uploadUrlCalls: any[];
} = {
  kits: [],
  voiceStatus: { enabled: true, configured: true, provider: "elevenlabs" },
  cloneCalls: [],
  uploadUrlCalls: [],
};

/** When set, the upload-url mutation waits on this before resolving. */
let heldUploadUrl: Promise<void> | null = null;
/** When set, the clone mutation waits on this before resolving. */
let heldClone: Promise<void> | null = null;

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: (...args: any[]) => toastSpy(...args),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({ data: mockState.kits, isLoading: false }),
    useGetBrandVoiceStatus: () => ({ data: mockState.voiceStatus, isLoading: false }),
    useCloneBrandVoice: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(async (vars: any) => {
        mockState.cloneCalls.push(vars);
        if (heldClone) await heldClone;
        return { activeVersion: { payload: null } };
      }),
    }),
    useRequestUploadUrl: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(async (vars: any) => {
        mockState.uploadUrlCalls.push(vars);
        if (heldUploadUrl) await heldUploadUrl;
        return { uploadURL: "https://upload.example/put", objectPath: "/objects/sample" };
      }),
    }),
  });
});

import { BrandKitsPage } from "./brand-kits";

function makeKit() {
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
        brand_voice: null,
      },
    },
  };
}

function makeClonedKit() {
  const kit = makeKit();
  kit.activeVersion.payload.brand_voice = {
    mode: "cloned",
    preset_voice: "alloy",
    delivery_style: "",
    provider: "elevenlabs",
    provider_voice_id: "v_abc123",
    sample_asset_path: "/objects/old-sample.webm",
    cloned_label: "Acme voice",
    cloned_at: "2025-01-01T00:00:00.000Z",
  } as any;
  return kit;
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

/**
 * Clicking Record opens the recording dialog on the ready stage (script +
 * tips); the mic only opens after the user presses Start recording.
 */
async function startFromDialog() {
  const startBtn = await screen.findByTestId("button-start-voice-recording");
  fireEvent.click(startBtn);
}

/** From the review stage, save the take (upload → clone). */
async function saveTake() {
  const saveBtn = await screen.findByTestId("button-save-voice-take");
  fireEvent.click(saveBtn);
}

/**
 * A controllable MediaRecorder double: `stop()` synchronously delivers one
 * audio chunk and fires onstop, so tests drive the whole record → review flow.
 */
class FakeMediaRecorder {
  static isTypeSupported = (_type: string) => true;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    // Match real browsers: state flips synchronously, but dataavailable/stop
    // events are delivered asynchronously afterwards.
    this.state = "inactive";
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: "audio/webm" }) });
      this.onstop?.();
    }, 0);
  }
}

/** Monotone fake clock so the elapsed-seconds check is deterministic. */
let nowMs = 0;

function installBase() {
  cleanup();
  mockState.voiceStatus = { enabled: true, configured: true, provider: "elevenlabs" };
  mockState.cloneCalls = [];
  mockState.uploadUrlCalls = [];
  heldUploadUrl = null;
  heldClone = null;
  toastSpy.mockClear();
  (globalThis as any).MediaRecorder = FakeMediaRecorder;
  // No Web Audio in jsdom — analysis fails soft and never blocks the upload.
  delete (window as any).AudioContext;
  (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
  // jsdom has no object-URL support; the review player needs one.
  (URL as any).createObjectURL = vi.fn(() => "blob:fake-take");
  (URL as any).revokeObjectURL = vi.fn();
  nowMs = 0;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
}

function installMic(getUserMedia: (...args: any[]) => Promise<any>) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
}

describe("In-browser voice sample recording", () => {
  beforeEach(() => {
    installBase();
    mockState.kits = [makeKit()];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).MediaRecorder;
  });

  it("opens the recording dialog with the script — the mic stays closed until Start", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    installMic(getUserMedia);
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));

    const dialog = await screen.findByTestId("dialog-record-voice");
    expect(dialog).toBeTruthy();
    // Script and room tips are shown while the user gets ready.
    expect(screen.getByTestId("text-recording-script-inline").textContent).toContain(
      "Have you ever noticed",
    );
    expect(screen.getByTestId("list-room-echo-tips")).toBeTruthy();
    // Recording has NOT started — mic untouched, no stop button.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByTestId("button-stop-voice-recording")).toBeNull();
  });

  it("records, shows elapsed time, then plays back the take for review before saving", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    expect(screen.getByTestId("text-recording-elapsed").textContent).toContain("0:00");

    nowMs = 45_000; // 45 seconds of speech
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    // Nothing uploads yet — the review stage appears with a player.
    const player = await screen.findByTestId("audio-recorded-take");
    expect((player as HTMLAudioElement).src).toContain("blob:fake-take");
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);

    // Name it and save.
    fireEvent.change(screen.getByTestId("input-voice-name"), {
      target: { value: "Founder's voice" },
    });
    await saveTake();

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(mockState.uploadUrlCalls).toHaveLength(1);
    expect(mockState.uploadUrlCalls[0].data.name).toBe("voice-sample.webm");
    expect(mockState.uploadUrlCalls[0].data.contentType).toBe("audio/webm");
    expect(mockState.cloneCalls[0]).toMatchObject({
      id: 7,
      data: { label: "Founder's voice" },
    });
  });

  it("lets the user re-record instead of saving — the first take is discarded", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    await screen.findByTestId("audio-recorded-take");

    fireEvent.click(screen.getByTestId("button-rerecord-voice"));

    // Back on the ready stage: take gone, nothing uploaded.
    await screen.findByTestId("button-start-voice-recording");
    expect(screen.queryByTestId("audio-recorded-take")).toBeNull();
    expect((URL as any).revokeObjectURL).toHaveBeenCalled();
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("shows the too-short message on the ready stage and skips the upload", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 5_000; // stopped after only 5 seconds
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    const error = await screen.findByTestId("text-record-error-dialog");
    expect(error.textContent).toContain("5 seconds");
    expect(error.textContent).toContain("at least 20 seconds");
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
    // Back on the ready stage — the user can immediately try again.
    expect(screen.getByTestId("button-start-voice-recording")).toBeTruthy();
  });

  it("discards an abandoned recording on unmount — no upload or clone", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 45_000; // long enough that an upload WOULD have been valid
    view.unmount(); // user closes the editor mid-recording

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("discards the take when the editor closes between Stop and the recorder's stop event", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 45_000;
    // Stop makes the recorder inactive immediately, but its onstop event is
    // still queued when the user closes the editor.
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    view.unmount();

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("releases the mic and never records when permission resolves after the editor closed", async () => {
    const trackStop = vi.fn();
    let grantMic: (stream: any) => void = () => {};
    installMic(
      () =>
        new Promise((resolve) => {
          grantMic = resolve;
        }),
    );
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    // Permission prompt still up — the user closes the editor, THEN grants.
    view.unmount();
    grantMic({ getTracks: () => [{ stop: trackStop }] });

    await new Promise((r) => setTimeout(r, 50));
    expect(trackStop).toHaveBeenCalled();
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("aborts the upload → clone chain when the editor closes mid-upload", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    // Hold the upload-url request so we can unmount while it's pending.
    let releaseUploadUrl: () => void = () => {};
    heldUploadUrl = new Promise<void>((resolve) => {
      releaseUploadUrl = resolve;
    });
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    await screen.findByTestId("audio-recorded-take");
    await saveTake();

    // The upload-url request is in flight.
    await waitFor(() => expect(mockState.uploadUrlCalls).toHaveLength(1));
    view.unmount();
    releaseUploadUrl();

    await new Promise((r) => setTimeout(r, 50));
    expect((globalThis.fetch as any).mock.calls.filter((c: any[]) => c[1]?.method === "PUT")).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("aborts an in-flight sample PUT when the editor closes, and never clones", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    // A PUT that only settles when its abort signal fires.
    let sawAbort = false;
    (globalThis as any).fetch = vi.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    await screen.findByTestId("audio-recorded-take");
    await saveTake();

    // Wait until the PUT is in flight, then close the editor.
    await waitFor(() => expect((globalThis.fetch as any).mock.calls).toHaveLength(1));
    toastSpy.mockClear();
    view.unmount();

    await new Promise((r) => setTimeout(r, 50));
    expect(sawAbort).toBe(true);
    expect(mockState.cloneCalls).toHaveLength(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("suppresses all post-clone effects when the editor closes while cloning", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    let releaseClone: () => void = () => {};
    heldClone = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    await screen.findByTestId("audio-recorded-take");
    await saveTake();

    // The clone request is in flight when the user closes the editor.
    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    toastSpy.mockClear();
    view.unmount();
    releaseClone();

    await new Promise((r) => setTimeout(r, 50));
    // No success toast, no error toast — every post-unmount effect suppressed.
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("revokes the take's object URL when the editor closes during review", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    await screen.findByTestId("audio-recorded-take");

    // Close the whole editor while the take sits on the review stage.
    view.unmount();

    expect((URL as any).revokeObjectURL).toHaveBeenCalledWith("blob:fake-take");
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("shows an inline message when microphone permission is denied", async () => {
    installMic(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();

    const error = await screen.findByTestId("text-record-error-dialog");
    expect(error.textContent).toContain("Microphone access was blocked");
    expect(screen.queryByTestId("button-stop-voice-recording")).toBeNull();
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("keeps the Record button disabled when cloning is blocked", async () => {
    mockState.voiceStatus = { enabled: false, configured: true, provider: "elevenlabs" };
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    expect((screen.getByTestId("button-record-voice-sample") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Re-record voice sample after cloning", () => {
  beforeEach(() => {
    installBase();
    mockState.kits = [makeClonedKit()];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).MediaRecorder;
  });

  it("shows a Record button in the cloned action row", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    // The cloned badge should be visible.
    expect(screen.getByText("Cloned voice active")).toBeTruthy();
    // Record button is present and enabled.
    const btn = screen.getByTestId("button-record-voice-sample") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it("records a NEW voice via the same record → review → save flow", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");
    // Elapsed timer is visible and starts at 0:00.
    expect(screen.getByTestId("text-recording-elapsed").textContent).toContain("0:00");

    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));
    await screen.findByTestId("audio-recorded-take");
    await saveTake();

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(mockState.uploadUrlCalls).toHaveLength(1);
    expect(mockState.uploadUrlCalls[0].data.name).toBe("voice-sample.webm");
    expect(mockState.cloneCalls[0]).toMatchObject({ id: 7 });
  });

  it("shows the too-short error in the cloned state", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 5_000; // only 5 seconds
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    const error = await screen.findByTestId("text-record-error-dialog");
    expect(error.textContent).toContain("5 seconds");
    expect(error.textContent).toContain("at least 20 seconds");
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
    // Start button comes back so the user can try again.
    expect(screen.getByTestId("button-start-voice-recording")).toBeTruthy();
  });

  it("shows the permission-denied error in the cloned state", async () => {
    installMic(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();

    const error = await screen.findByTestId("text-record-error-dialog");
    expect(error.textContent).toContain("Microphone access was blocked");
    expect(screen.queryByTestId("button-stop-voice-recording")).toBeNull();
    expect(mockState.uploadUrlCalls).toHaveLength(0);
  });

  it("keeps the Record button disabled when cloning is blocked in cloned state", async () => {
    mockState.voiceStatus = { enabled: false, configured: true, provider: "elevenlabs" };
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    expect((screen.getByTestId("button-record-voice-sample") as HTMLButtonElement).disabled).toBe(true);
  });

  it("discards an abandoned re-recording on unmount — no upload or clone", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await startFromDialog();
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 45_000;
    view.unmount();

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("shows the recording dialog (script + tips) before the mic opens in the cloned state", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    installMic(getUserMedia);
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));

    const dialog = await screen.findByTestId("dialog-record-voice");
    expect(dialog).toBeTruthy();
    // Recording has NOT started yet — no stop button, mic untouched.
    expect(screen.queryByTestId("button-stop-voice-recording")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    // Tips list is rendered inside the dialog.
    expect(screen.getByTestId("list-room-echo-tips")).toBeTruthy();
  });

  it("closing the recording dialog without starting does not record anything", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    installMic(getUserMedia);
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    const dialog = await screen.findByTestId("dialog-record-voice");

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("dialog-record-voice")).toBeNull());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });
});
