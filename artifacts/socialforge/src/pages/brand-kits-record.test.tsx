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
 * A controllable MediaRecorder double: `stop()` synchronously delivers one
 * audio chunk and fires onstop, so tests drive the whole record → upload flow.
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

describe("In-browser voice sample recording", () => {
  beforeEach(() => {
    cleanup();
    mockState.kits = [makeKit()];
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
    nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).MediaRecorder;
  });

  function installMic(getUserMedia: (...args: any[]) => Promise<any>) {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
  }

  it("records, shows elapsed time, and feeds the upload → clone flow", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await screen.findByTestId("button-stop-voice-recording");
    expect(screen.getByTestId("text-recording-elapsed").textContent).toContain("0:00");
    // Upload button is parked while the mic is live.
    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(true);

    nowMs = 45_000; // 45 seconds of speech
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    expect(mockState.uploadUrlCalls).toHaveLength(1);
    expect(mockState.uploadUrlCalls[0].data.name).toBe("voice-sample.webm");
    expect(mockState.uploadUrlCalls[0].data.contentType).toBe("audio/webm");
    expect(mockState.cloneCalls[0]).toMatchObject({ id: 7 });
    expect(screen.queryByTestId("text-record-error")).toBeNull();
  });

  it("shows an inline too-short message and skips the upload", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 5_000; // stopped after only 5 seconds
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    const error = await screen.findByTestId("text-record-error");
    expect(error.textContent).toContain("5 seconds");
    expect(error.textContent).toContain("at least 20 seconds");
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
    // Back to idle — the user can immediately try again.
    expect(screen.getByTestId("button-record-voice-sample")).toBeTruthy();
  });

  it("discards an abandoned recording on unmount — no upload or clone", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
    await screen.findByTestId("button-stop-voice-recording");

    nowMs = 45_000; // long enough that an upload WOULD have been valid
    view.unmount(); // user closes the editor mid-recording

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.uploadUrlCalls).toHaveLength(0);
    expect(mockState.cloneCalls).toHaveLength(0);
  });

  it("discards the sample when the editor closes between Stop and the recorder's stop event", async () => {
    installMic(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const view = renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));
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
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    // onstop has fired and the upload-url request is in flight.
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
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

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
    await screen.findByTestId("button-stop-voice-recording");
    nowMs = 45_000;
    fireEvent.click(screen.getByTestId("button-stop-voice-recording"));

    // The clone request is in flight when the user closes the editor.
    await waitFor(() => expect(mockState.cloneCalls).toHaveLength(1));
    toastSpy.mockClear();
    view.unmount();
    releaseClone();

    await new Promise((r) => setTimeout(r, 50));
    // No success toast, no error toast — every post-unmount effect suppressed.
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("shows an inline message when microphone permission is denied", async () => {
    installMic(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-record-voice-sample"));

    const error = await screen.findByTestId("text-record-error");
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
