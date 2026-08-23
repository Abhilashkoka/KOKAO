/**
 * Mobile Brand Voice screen:
 * - shows the cloned-voice state with preview + remove, or the stock-voice note
 * - shows clear messaging when the feature is off or unconfigured
 * - saving a stock voice / delivery style creates a new ACTIVATED kit version
 *   from a deep clone of the active payload (other sections preserved)
 * - remove goes through an in-app confirm dialog (no native confirm)
 * - audio generation happy/error paths
 * - performUpload failure modes: presigned-PUT fails, clone API fails after
 *   upload succeeds, unmount mid-upload does not crash or leak error state
 * - after cloning succeeds, the preview is auto-requested and played once;
 *   tapping "Play preview" again replays from the cached path.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// vi.hoisted ensures all mutable mock references are available inside the
// hoisted vi.mock factory calls, which run before module-level statements.
const {
  previewMutate,
  removeMutate,
  createVersionMutate,
  createAudioMutate,
  createAudioMutationState,
  playerMock,
  playerStatus,
  requestUploadMutateAsync,
  requestUploadMutationState,
  cloneVoiceMutateAsync,
  getDocumentAsync,
  uploadAsync,
  recorderMock,
} = vi.hoisted(() => ({
  previewMutate: vi.fn(),
  removeMutate: vi.fn(),
  createVersionMutate: vi.fn(),
  createAudioMutate: vi.fn(),
  createAudioMutationState: { isPending: false },
  playerMock: { replace: vi.fn(), play: vi.fn(), seekTo: vi.fn(), pause: vi.fn() },
  playerStatus: { playing: false },
  requestUploadMutateAsync: vi.fn(),
  requestUploadMutationState: { isPending: false },
  cloneVoiceMutateAsync: vi.fn(),
  getDocumentAsync: vi.fn(),
  uploadAsync: vi.fn(),
  recorderMock: {
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    uri: null as string | null,
    isRecording: false,
    currentTime: 0,
    getStatus: vi.fn(),
  },
}));

const basePayload = {
  identity: { name: "Kokao", tagline: "hello" },
  colors: { primary: [{ hex: "#112233", name: "Ink" }] },
  brand_voice: {
    mode: "preset",
    preset_voice: "alloy",
    delivery_style: "",
    provider: null,
    provider_voice_id: null,
    sample_asset_path: null,
    cloned_label: null,
    cloned_at: null,
  },
};

const clonedVoicePayload = {
  ...basePayload,
  brand_voice: {
    mode: "cloned",
    preset_voice: "alloy",
    delivery_style: "",
    provider: "elevenlabs",
    provider_voice_id: "voice_123",
    sample_asset_path: "/objects/t/s.mp3",
    cloned_label: "Kokao voice",
    cloned_at: "2026-08-01T00:00:00.000Z",
  },
};

const mockState: {
  status: { enabled: boolean; configured: boolean; provider: string } | undefined;
  kits: Array<Record<string, unknown>>;
  payload: Record<string, unknown>;
} = {
  status: { enabled: true, configured: true, provider: "elevenlabs" },
  kits: [{ id: 5, name: "Kokao", isDefault: true, isArchived: false }],
  payload: basePayload,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({
      data: mockState.kits,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useGetBrandKit: () => ({
      data: {
        id: 5,
        name: "Kokao",
        activeVersion: { id: 9, payload: mockState.payload },
      },
      isLoading: false,
      isFetching: false,
    }),
    useGetBrandVoiceStatus: () => ({
      data: mockState.status,
      isLoading: false,
    }),
    usePreviewBrandVoice: () => ({ ...idleMutation(), mutate: previewMutate }),
    useRemoveBrandVoice: () => ({ ...idleMutation(), mutate: removeMutate }),
    useCreateBrandKitVersion: () => ({ ...idleMutation(), mutate: createVersionMutate }),
    useCreateBrandVoiceAudio: () => ({
      ...idleMutation(),
      mutate: createAudioMutate,
      isPending: createAudioMutationState.isPending,
    }),
    useRequestUploadUrl: () => ({
      ...idleMutation(),
      mutateAsync: requestUploadMutateAsync,
      isPending: requestUploadMutationState.isPending,
    }),
    useCloneBrandVoice: () => ({
      ...idleMutation(),
      mutateAsync: cloneVoiceMutateAsync,
      isPending: false,
    }),
  });
});

vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: () => Promise.resolve("test-token") }),
}));
vi.mock("expo-audio", () => ({
  useAudioPlayer: () => playerMock,
  useAudioPlayerStatus: () => playerStatus,
  useAudioRecorder: () => recorderMock,
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true })),
  setAudioModeAsync: vi.fn(async () => {}),
}));
vi.mock("expo-document-picker", () => ({
  getDocumentAsync,
}));
vi.mock("expo-file-system/legacy", () => ({
  uploadAsync,
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  readAsStringAsync: vi.fn(async () => ""),
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: "multipart" },
}));
vi.mock("@/lib/haptics", () => ({ haptic: () => {} }));
vi.mock("@/lib/verifyFailureNotice", () => ({
  verifyFailureNotice: vi.fn().mockReturnValue(null),
}));
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: () => null,
  useRazorpayWalletRecharge: () => ({ open: vi.fn(), isOpen: false }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => false,
  isQuotaError: () => false,
  QUOTA_FALLBACK_MESSAGE: "",
  QUOTA_OWNER_WALLET_MESSAGE: "",
  QUOTA_MEMBER_ASK_OWNER_MESSAGE: "",
  QuotaInfoSheet: () => null,
  QuotaErrorNotice: () => null,
}));

import BrandVoiceScreen, { meteringToLevel } from "../app/brand-voice";
/** Flush all pending resolved-promise microtasks. */
const flushPromises = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrandVoiceScreen />
    </QueryClientProvider>,
  );
}

/** Open the clone modal and click "Pick an audio file". */
async function openCloneAndPickFile() {
  fireEvent.click(screen.getByText("Clone your voice"));
  await waitFor(() => expect(screen.getByText("Pick an audio file")).toBeTruthy());
  fireEvent.click(screen.getByText("Pick an audio file"));
}

beforeEach(() => {
  cleanup();
  previewMutate.mockReset();
  removeMutate.mockReset();
  createVersionMutate.mockReset();
  createAudioMutate.mockReset();
  createAudioMutationState.isPending = false;
  playerMock.replace.mockReset();
  playerMock.play.mockReset();
  playerMock.pause.mockReset();
  playerStatus.playing = false;
  // Reset upload-chain mocks so call counts don't bleed between tests.
  requestUploadMutateAsync.mockReset();
  requestUploadMutationState.isPending = false;
  cloneVoiceMutateAsync.mockReset();
  getDocumentAsync.mockReset();
  uploadAsync.mockReset();
  recorderMock.prepareToRecordAsync.mockReset();
  recorderMock.record.mockReset();
  recorderMock.stop.mockReset();
  recorderMock.stop.mockResolvedValue(undefined);
  recorderMock.uri = null;
  recorderMock.getStatus.mockReset();
  recorderMock.getStatus.mockReturnValue({});

  mockState.status = { enabled: true, configured: true, provider: "elevenlabs" };
  mockState.kits = [{ id: 5, name: "Kokao", isDefault: true, isArchived: false }];
  mockState.payload = JSON.parse(JSON.stringify(basePayload));

  // Default upload-chain stubs — override per test as needed.
  requestUploadMutateAsync.mockResolvedValue({
    uploadURL: "https://upload.example.com/voice-sample",
    objectPath: "/objects/t5/voice-sample.m4a",
  });
  cloneVoiceMutateAsync.mockResolvedValue(undefined);

  // Default picker: user picks a valid 1 MB audio file.
  getDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: "file:///tmp/voice-sample.m4a",
        name: "voice-sample.m4a",
        mimeType: "audio/mp4",
        size: 1_000_000,
      },
    ],
  });

  // Default uploadAsync: successful 200.
  uploadAsync.mockResolvedValue({ status: 200, body: "" });
});

describe("BrandVoiceScreen", () => {
  it.each([
    ["grey", -50.1, "#71717a"],
    ["green", -50, "#22c55e"],
    ["green", -6.01, "#22c55e"],
    ["amber", -6, "#f59e0b"],
    ["amber", -1.01, "#f59e0b"],
    ["red", -1, "#ef4444"],
  ])("maps %s metering values to the right color", (_zone, db, color) => {
    expect(meteringToLevel(db)).toMatchObject({ color });
  });

  it("shows the live level bar while recording has metering, then removes it when stopped", async () => {
    vi.useFakeTimers();
    try {
      recorderMock.getStatus.mockReturnValue({ metering: -12 });
      renderScreen();

      act(() => {
        fireEvent.click(screen.getByText("Clone your voice"));
      });
      act(() => {
        fireEvent.click(screen.getByText("Record a sample"));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Stop recording")).toBeTruthy();
      expect(screen.queryByTestId("voice-level-bar")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(screen.getByTestId("voice-level-bar")).toBeTruthy();

      act(() => {
        fireEvent.click(screen.getByText("Stop recording"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByTestId("voice-level-bar")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the stock-voice state for a preset kit", () => {
    renderScreen();
    expect(screen.getByTestId("text-brand-voice-stock")).toBeTruthy();
    expect(screen.queryByText("Cloned voice active")).toBeNull();
    // Current preset is reflected in the picker.
    expect(screen.getByTestId("voice-alloy")).toBeTruthy();
  });

  it("shows disabled messaging when the feature is off", () => {
    mockState.status = { enabled: false, configured: true, provider: "elevenlabs" };
    renderScreen();
    expect(screen.getByTestId("text-brand-voice-disabled")).toBeTruthy();
  });

  it("shows unconfigured messaging when no provider key is set up", () => {
    mockState.status = { enabled: true, configured: false, provider: "elevenlabs" };
    renderScreen();
    expect(screen.getByTestId("text-brand-voice-unconfigured")).toBeTruthy();
  });

  it("saves a stock voice change as a new activated version with sections preserved", async () => {
    renderScreen();
    fireEvent.click(screen.getByTestId("voice-nova"));
    fireEvent.click(screen.getByText("Save voice settings"));
    await waitFor(() => expect(createVersionMutate).toHaveBeenCalledTimes(1));
    const arg = createVersionMutate.mock.calls[0][0];
    expect(arg.id).toBe(5);
    expect(arg.data.activate).toBe(true);
    expect(arg.data.approvalStatus).toBe("approved");
    expect(arg.data.payload.brand_voice.preset_voice).toBe("nova");
    // Other sections survive the round-trip untouched.
    expect(arg.data.payload.identity).toEqual(basePayload.identity);
    expect(arg.data.payload.colors).toEqual(basePayload.colors);
  });

  it("happy path: entering a script and pressing Generate audio calls the mutation, shows the notice and Play/Share buttons", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();

    // Type a script into the input.
    const input = screen.getByTestId("input-audio-script");
    fireEvent.change(input, { target: { value: "Hello from my cloned voice." } });

    // Click the Generate audio button.
    fireEvent.click(screen.getByTestId("button-generate-audio"));
    await waitFor(() => expect(createAudioMutate).toHaveBeenCalledTimes(1));

    // Verify the mutation received the right args.
    const [vars, opts] = createAudioMutate.mock.calls[0] as [
      { id: number; data: { text: string } },
      { onSuccess: (r: { audioPath: string }) => void; onError: (e: unknown) => void },
    ];
    expect(vars.id).toBe(5);
    expect(vars.data.text).toBe("Hello from my cloned voice.");

    // Simulate the mutation succeeding.
    act(() => {
      opts.onSuccess({ audioPath: "/objects/t/out.mp3" });
    });

    // Notice and Play/Share buttons should now be visible.
    await waitFor(() => expect(screen.getByText("Audio ready — playing now.")).toBeTruthy());
    expect(screen.getByText("Play again")).toBeTruthy();
    expect(screen.getByText("Share / Save")).toBeTruthy();
  });

  it("second generate replaces old result: Play/Share disappear while pending and reappear once after success", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();

    const input = screen.getByTestId("input-audio-script");
    fireEvent.change(input, { target: { value: "First take." } });

    // ── First generation ───────────────────────────────────────────────────
    fireEvent.click(screen.getByTestId("button-generate-audio"));
    await waitFor(() => expect(createAudioMutate).toHaveBeenCalledTimes(1));

    const [, opts1] = createAudioMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (r: { audioPath: string }) => void; onError: (e: unknown) => void },
    ];
    act(() => {
      opts1.onSuccess({ audioPath: "/objects/t/out1.mp3" });
    });

    // Play/Share buttons are visible after the first result.
    await waitFor(() => expect(screen.getByText("Play again")).toBeTruthy());
    expect(screen.getByText("Share / Save")).toBeTruthy();

    // ── Second generation (script changed) ────────────────────────────────
    fireEvent.change(input, { target: { value: "Second take." } });
    fireEvent.click(screen.getByTestId("button-generate-audio"));

    // handleGenerateAudio calls setGeneratedAudioPath(null) synchronously
    // before the mutation fires, so the buttons must be gone immediately.
    await waitFor(() => {
      expect(screen.queryByText("Play again")).toBeNull();
      expect(screen.queryByText("Share / Save")).toBeNull();
    });

    // The mutation was fired a second time.
    await waitFor(() => expect(createAudioMutate).toHaveBeenCalledTimes(2));

    const [, opts2] = createAudioMutate.mock.calls[1] as [
      unknown,
      { onSuccess: (r: { audioPath: string }) => void; onError: (e: unknown) => void },
    ];
    act(() => {
      opts2.onSuccess({ audioPath: "/objects/t/out2.mp3" });
    });

    // After the second success exactly one Play again and one Share / Save button
    // should be rendered — no stale duplicates from the first result.
    await waitFor(() => expect(screen.getByText("Play again")).toBeTruthy());
    expect(screen.getAllByText("Play again")).toHaveLength(1);
    expect(screen.getAllByText("Share / Save")).toHaveLength(1);
  });

  it("disables Generate audio while a second generation is in flight, then re-enables it after success", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    let firstOptions:
      | { onSuccess: (result: { audioPath: string }) => void }
      | undefined;
    let secondOptions:
      | { onSuccess: (result: { audioPath: string }) => void }
      | undefined;

    createAudioMutate.mockImplementation((_vars, options) => {
      createAudioMutationState.isPending = true;
      if (!firstOptions) {
        firstOptions = options;
      } else {
        secondOptions = options;
      }
    });

    renderScreen();
    const input = screen.getByTestId("input-audio-script");
    const button = screen.getByTestId("button-generate-audio");

    // Complete an initial request so the second request synchronously clears
    // a visible result and causes the mock's pending state to render.
    fireEvent.change(input, { target: { value: "First take." } });
    fireEvent.click(button);
    await waitFor(() => expect(firstOptions).toBeDefined());
    createAudioMutationState.isPending = false;
    act(() => {
      firstOptions!.onSuccess({ audioPath: "/objects/t/out1.mp3" });
    });
    await waitFor(() => expect(screen.getByText("Play again")).toBeTruthy());

    fireEvent.change(input, { target: { value: "Second take." } });
    fireEvent.click(button);
    await waitFor(() => expect(secondOptions).toBeDefined());

    // The in-flight second request must block a third overlapping request.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(createAudioMutate).toHaveBeenCalledTimes(2);

    createAudioMutationState.isPending = false;
    act(() => {
      secondOptions!.onSuccess({ audioPath: "/objects/t/out2.mp3" });
    });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
  });

  it("error path: mutation failure shows an error notice and does not show Play/Share buttons", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();

    const input = screen.getByTestId("input-audio-script");
    fireEvent.change(input, { target: { value: "This will fail." } });
    fireEvent.click(screen.getByTestId("button-generate-audio"));
    await waitFor(() => expect(createAudioMutate).toHaveBeenCalledTimes(1));

    const [, opts] = createAudioMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (r: unknown) => void; onError: (e: unknown) => void },
    ];

    // Simulate the mutation failing.
    act(() => {
      opts.onError({ data: { error: "Voice provider unavailable." } });
    });

    // Error notice should be visible.
    await waitFor(() =>
      expect(screen.getByText("Voice provider unavailable.")).toBeTruthy(),
    );

    // Play/Share buttons must NOT appear.
    expect(screen.queryByText("Play again")).toBeNull();
    expect(screen.queryByText("Share / Save")).toBeNull();
  });

  it("Generate audio button is disabled and mutation is not called when the script is empty", () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();

    // The script input starts empty — the button must carry aria-disabled.
    const button = screen.getByTestId("button-generate-audio");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    // Clicking the disabled button must NOT invoke the mutation.
    fireEvent.click(button);
    expect(createAudioMutate).not.toHaveBeenCalled();
  });

  it("Generate audio button is disabled for whitespace-only input and enabled only after non-whitespace is typed", () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();

    const input = screen.getByTestId("input-audio-script");
    const button = screen.getByTestId("button-generate-audio");

    // Whitespace-only script must keep the button disabled.
    fireEvent.change(input, { target: { value: "   " } });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(createAudioMutate).not.toHaveBeenCalled();

    // Non-whitespace text must enable the button.
    fireEvent.change(input, { target: { value: "A real script." } });
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("shows cloned state with preview and confirm-gated remove", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();
    expect(screen.getByText("Cloned voice active")).toBeTruthy();
    expect(screen.getByText("Kokao voice", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByText("Play preview"));
    expect(previewMutate).toHaveBeenCalledTimes(1);
    expect(previewMutate.mock.calls[0][0]).toEqual({ id: 5, data: {} });

    // Remove requires the in-app confirm dialog first.
    fireEvent.click(screen.getByText("Remove"));
    expect(removeMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Remove brand voice?")).toBeTruthy();
    const removeButtons = screen.getAllByText("Remove");
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    await waitFor(() => expect(removeMutate).toHaveBeenCalledTimes(1));
    expect(removeMutate.mock.calls[0][0]).toEqual({ id: 5 });
  });

  it("shows Stop for a playing cloned-voice preview and pauses it when tapped", () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    playerStatus.playing = true;
    renderScreen();

    expect(screen.getByTestId("button-stop-audio")).toBeTruthy();
    expect(screen.queryByText("Play preview")).toBeNull();

    fireEvent.click(screen.getByTestId("button-stop-audio"));
    expect(playerMock.pause).toHaveBeenCalledTimes(1);
  });

  it("shows Play preview instead of Stop after cloned-voice playback ends", () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    playerStatus.playing = false;
    renderScreen();

    expect(screen.getByText("Play preview")).toBeTruthy();
    expect(screen.queryByTestId("button-stop-audio")).toBeNull();
  });

  it("switches generated audio between Play again and Stop based on playback status", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    playerStatus.playing = false;
    const { rerender } = renderScreen();
    fireEvent.change(screen.getByTestId("input-audio-script"), {
      target: { value: "Listen to this generated clip." },
    });
    fireEvent.click(screen.getByTestId("button-generate-audio"));
    await waitFor(() => expect(createAudioMutate).toHaveBeenCalledTimes(1));

    const [, options] = createAudioMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (result: { audioPath: string }) => void },
    ];
    act(() => {
      options.onSuccess({ audioPath: "/objects/t/generated.mp3" });
    });

    expect(screen.getByText("Play again")).toBeTruthy();
    expect(screen.queryByTestId("button-stop-audio-generated")).toBeNull();

    playerStatus.playing = true;
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrandVoiceScreen />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("button-stop-audio-generated")).toBeTruthy();
    expect(screen.queryByText("Play again")).toBeNull();
    fireEvent.click(screen.getByTestId("button-stop-audio-generated"));
    expect(playerMock.pause).toHaveBeenCalledTimes(1);
  });

  // ── Auto-preview after clone ───────────────────────────────────────────────

  it("auto-requests a preview immediately after cloning succeeds", async () => {
    renderScreen();

    await openCloneAndPickFile();
    await flushPromises();

    await waitFor(() => expect(requestUploadMutateAsync).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(cloneVoiceMutateAsync).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // previewVoice.mutate must be called automatically with the kit id.
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(previewMutate.mock.calls[0][0]).toEqual({ id: 5, data: {} });

    // Notice shows "Generating preview…" while the call is in-flight.
    expect(screen.getByText("Brand voice cloned! Generating preview…")).toBeTruthy();
  });

  it("updates the notice to 'preview playing' when auto-preview API succeeds", async () => {
    renderScreen();

    await openCloneAndPickFile();
    await flushPromises();

    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Simulate the preview API succeeding.
    const [, previewOpts] = previewMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (r: unknown) => void; onError: (e: unknown) => void },
    ];
    act(() => { previewOpts.onSuccess({ audioPath: "/objects/t/preview.mp3" }); });

    // Notice confirms playback started.
    await waitFor(() =>
      expect(screen.getByText("Brand voice cloned — preview playing.")).toBeTruthy(),
    );
  });

  it("falls back to a manual-replay notice when the auto-preview API call fails", async () => {
    renderScreen();

    await openCloneAndPickFile();
    await flushPromises();

    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Simulate the preview API failing.
    const [, previewOpts] = previewMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (r: unknown) => void; onError: (e: unknown) => void },
    ];
    act(() => { previewOpts.onError({ data: { error: "TTS service unavailable." } }); });

    // A fallback notice should still confirm cloning worked.
    await waitFor(() => expect(screen.getByText(/Brand voice cloned/)).toBeTruthy());
  });

  it("auto-preview no-ops when the user leaves the screen while it is generating", async () => {
    let capturedPreviewOpts:
      | { onSuccess: (r: { audioPath: string }) => void; onError: (e: unknown) => void }
      | undefined;
    // Capture the preview mutation options so we can resolve AFTER unmount.
    previewMutate.mockImplementation((_vars: unknown, opts: typeof capturedPreviewOpts) => {
      capturedPreviewOpts = opts;
    });

    cloneVoiceMutateAsync.mockResolvedValue({});
    const { unmount } = renderScreen();
    await openCloneAndPickFile();

    // The auto-preview request fired after cloning; leave the screen now.
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(1));
    act(() => { unmount(); });

    // Resolving the preview after unmount must be a full no-op: the disposed
    // guard must stop playback from starting, not just avoid a crash.
    playerMock.replace.mockClear();
    playerMock.play.mockClear();
    act(() => { capturedPreviewOpts!.onSuccess({ audioPath: "/objects/t/preview.mp3" }); });
    expect(playerMock.replace).not.toHaveBeenCalled();
    expect(playerMock.play).not.toHaveBeenCalled();
  });

  it("ignores stale auto-preview callbacks after switching brand kits", async () => {
    let capturedPreviewOpts:
      | { onSuccess: (r: { audioPath: string }) => void; onError: (e: unknown) => void }
      | undefined;
    previewMutate.mockImplementation((_vars: unknown, opts: typeof capturedPreviewOpts) => {
      capturedPreviewOpts = opts;
    });
    mockState.kits = [
      { id: 5, name: "Kokao", isDefault: true, isArchived: false },
      { id: 6, name: "Second kit", isDefault: false, isArchived: false },
    ];

    renderScreen();
    await openCloneAndPickFile();
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(previewMutate.mock.calls[0][0]).toEqual({ id: 5, data: {} });

    // Switch to kit B before the cloned kit A preview settles.
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    fireEvent.click(screen.getByText("Second kit"));
    await waitFor(() =>
      expect(screen.queryByText("Brand voice cloned! Generating preview…")).toBeNull(),
    );

    playerMock.replace.mockClear();
    playerMock.play.mockClear();
    act(() => {
      capturedPreviewOpts!.onSuccess({ audioPath: "/objects/t5/stale-preview.mp3" });
      capturedPreviewOpts!.onError({ data: { error: "TTS service unavailable." } });
    });

    // Neither stale completion may play audio or surface a notice in kit B.
    expect(playerMock.replace).not.toHaveBeenCalled();
    expect(playerMock.play).not.toHaveBeenCalled();
    expect(screen.queryByText("Brand voice cloned — preview playing.")).toBeNull();
    expect(screen.queryByText(/TTS service unavailable/)).toBeNull();

    // The stale success also must not leave kit B with kit A's cached path.
    fireEvent.click(screen.getByText("Play preview"));
    expect(previewMutate).toHaveBeenCalledTimes(2);
    expect(previewMutate.mock.calls[1][0]).toEqual({ id: 6, data: {} });
  });

  it("replays cached preview path on a second 'Play preview' tap without a new API call", async () => {
    mockState.payload = JSON.parse(JSON.stringify(clonedVoicePayload));
    renderScreen();

    // First tap calls the API.
    fireEvent.click(screen.getByText("Play preview"));
    expect(previewMutate).toHaveBeenCalledTimes(1);

    // Simulate success → path is cached.
    const [, opts] = previewMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (r: { audioPath: string }) => void; onError: (e: unknown) => void },
    ];
    act(() => { opts.onSuccess({ audioPath: "/objects/t/preview.mp3" }); });

    // Second tap must NOT trigger a new API call.
    fireEvent.click(screen.getByText("Play preview"));
    expect(previewMutate).toHaveBeenCalledTimes(1); // still only once
  });
});

// ── performUpload failure modes ────────────────────────────────────────────

describe("performUpload — presigned PUT fails", () => {
  it("shows a specific error when the PUT returns a 4xx status", async () => {
    uploadAsync.mockResolvedValue({ status: 403, body: "Forbidden" });

    renderScreen();
    await openCloneAndPickFile();

    await waitFor(() =>
      expect(screen.getByTestId("text-record-error")).toBeTruthy(),
    );
    const errText = screen.getByTestId("text-record-error").textContent ?? "";
    // Some actionable text must appear — the user must not see nothing.
    expect(errText.length).toBeGreaterThan(5);
  });

  it("confirms the upload step DID run before the clone step failed", async () => {
    cloneVoiceMutateAsync.mockRejectedValue(new Error("clone failed"));

    renderScreen();
    await openCloneAndPickFile();

    await waitFor(() => expect(screen.getByTestId("text-record-error")).toBeTruthy());
    // Both upload steps ran in sequence.
    expect(requestUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadAsync).toHaveBeenCalledTimes(1);
    expect(cloneVoiceMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("clears the uploading spinner after a clone failure", async () => {
    cloneVoiceMutateAsync.mockRejectedValue(new Error("clone failed"));

    renderScreen();
    await openCloneAndPickFile();

    await waitFor(() => expect(screen.getByTestId("text-record-error")).toBeTruthy());
    expect(screen.queryByText("Uploading sample…")).toBeNull();
    expect(screen.queryByText("Cloning your voice…")).toBeNull();
  });
});

describe("performUpload — stalled upload timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("surfaces an error and re-shows the Cancel button when uploadAsync hangs past the timeout", async () => {
    // uploadAsync hangs indefinitely — simulates a dropped-wifi stall.
    uploadAsync.mockReturnValue(new Promise(() => {}));

    renderScreen();

    // Open the clone modal and trigger the file pick synchronously (no async
    // waitFor needed — modal renders in the same act cycle as the click).
    fireEvent.click(screen.getByText("Clone your voice"));
    fireEvent.click(screen.getByText("Pick an audio file"));

    // Flush all resolved-promise microtasks so the async chain inside
    // performUpload (getDocumentAsync → requestUploadMutateAsync → uploadAsync)
    // runs far enough to register the 60-second upload-timeout via setTimeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Advance fake clock past the 60-second upload timeout so the Promise.race
    // rejects and the error-handling path runs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });

    // The timeout error message must be visible.
    expect(screen.getByTestId("text-record-error")).toBeTruthy();
    const errText = screen.getByTestId("text-record-error").textContent ?? "";
    expect(errText).toMatch(/timed out|connection/i);
    // Some actionable text must appear — the user must not see nothing.
    expect(errText.length).toBeGreaterThan(5);

    // The Cancel button must be re-visible so the user can escape the modal.
    expect(screen.getByText("Cancel")).toBeTruthy();
  });
});

describe("performUpload — stalled presigned URL timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("surfaces an error and re-shows Cancel when the presigned URL request hangs", async () => {
    // The mutation never settles — simulates a network drop before the file PUT
    // can start.
    requestUploadMutateAsync.mockImplementation(() => {
      requestUploadMutationState.isPending = true;
      return new Promise(() => {});
    });

    renderScreen();
    fireEvent.click(screen.getByText("Clone your voice"));
    fireEvent.click(screen.getByText("Pick an audio file"));

    // Let the picker and mutation start, registering the URL-request timeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestUploadMutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });

    const error = screen.getByTestId("text-record-error");
    expect(error.textContent ?? "").toMatch(/preparing.*timed out|timed out.*connection/i);
    // The underlying non-abortable mutation is still pending, but the timed-out
    // local flow no longer treats it as busy, so the user can dismiss the dialog.
    expect(requestUploadMutationState.isPending).toBe(true);
    expect(screen.getByText("Cancel")).toBeTruthy();
    expect(uploadAsync).not.toHaveBeenCalled();
    expect(cloneVoiceMutateAsync).not.toHaveBeenCalled();
  });
});

describe("performUpload — unmount during upload", () => {
  it("does not clone when the upload-url request resolves after unmount", async () => {
    // The presigned URL request hangs until we resolve it manually.
    let resolveUploadUrl!: (v: { uploadURL: string; objectPath: string }) => void;
    requestUploadMutateAsync.mockReturnValue(
      new Promise<{ uploadURL: string; objectPath: string }>((resolve) => {
        resolveUploadUrl = resolve;
      }),
    );

    const { unmount } = renderScreen();
    await openCloneAndPickFile();

    // Unmount while the upload URL request is still in-flight.
    act(() => { unmount(); });

    // Resolve AFTER unmount — must not throw or update state.
    await act(async () => {
      resolveUploadUrl({ uploadURL: "https://upload.example.com/", objectPath: "/objects/t/s.m4a" });
    });

    // The clone step must not have been called because disposedRef guards it.
    expect(cloneVoiceMutateAsync).not.toHaveBeenCalled();
  });

  it("does not show an error or crash after unmounting during the file PUT", async () => {
    let resolvePut!: (v: { status: number; body: string }) => void;
    uploadAsync.mockReturnValue(
      new Promise<{ status: number; body: string }>((resolve) => {
        resolvePut = resolve;
      }),
    );

    const { unmount } = renderScreen();
    await openCloneAndPickFile();

    // Wait for uploadAsync to be called (presigned URL step finished).
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledTimes(1));

    act(() => { unmount(); });

    // Resolve the PUT after unmount.
    await act(async () => {
      resolvePut({ status: 200, body: "" });
    });

    // The clone step must not have been called — disposedRef.current was true.
    expect(cloneVoiceMutateAsync).not.toHaveBeenCalled();
  });
});
