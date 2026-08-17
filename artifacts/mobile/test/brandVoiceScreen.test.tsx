/**
 * Mobile Brand Voice screen:
 * - shows the cloned-voice state with preview + remove, or the stock-voice note
 * - shows clear messaging when the feature is off or unconfigured
 * - saving a stock voice / delivery style creates a new ACTIVATED kit version
 *   from a deep clone of the active payload (other sections preserved)
 * - remove goes through an in-app confirm dialog (no native confirm)
 * - audio generation happy/error paths (task #876)
 * - performUpload failure modes: presigned-PUT fails, clone API fails after
 *   upload succeeds, unmount mid-upload does not crash or leak error state (task #884)
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// vi.hoisted ensures all mutable mock references are available inside the
// hoisted vi.mock factory calls, which run before module-level statements.
const {
  previewMutate,
  removeMutate,
  createVersionMutate,
  createAudioMutate,
  playerMock,
  requestUploadMutateAsync,
  cloneVoiceMutateAsync,
  getDocumentAsync,
  uploadAsync,
} = vi.hoisted(() => ({
  previewMutate: vi.fn(),
  removeMutate: vi.fn(),
  createVersionMutate: vi.fn(),
  createAudioMutate: vi.fn(),
  playerMock: { replace: vi.fn(), play: vi.fn(), seekTo: vi.fn() },
  requestUploadMutateAsync: vi.fn(),
  cloneVoiceMutateAsync: vi.fn(),
  getDocumentAsync: vi.fn(),
  uploadAsync: vi.fn(),
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
    useCreateBrandVoiceAudio: () => ({ ...idleMutation(), mutate: createAudioMutate }),
    useRequestUploadUrl: () => ({
      ...idleMutation(),
      mutateAsync: requestUploadMutateAsync,
      isPending: false,
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
// react-native-safe-area-context is pulled in transitively via QuotaInfoSheet.
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => ({ walletBalance: null, isWalletUser: false }),
  QuotaInfoSheet: () => null,
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: () => Promise.resolve("test-token") }),
}));
vi.mock("expo-audio", () => ({
  useAudioPlayer: () => playerMock,
  useAudioRecorder: () => ({
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(async () => ({ uri: "file://rec.m4a" })),
    uri: null,
    isRecording: false,
    currentTime: 0,
    getStatus: vi.fn().mockReturnValue({}),
  }),
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true })),
  setAudioModeAsync: vi.fn(async () => {}),
}));
vi.mock("@/lib/haptics", () => ({ haptic: () => {} }));
// QuotaInfoSheet → react-native-safe-area-context (native): mock the sheet
// itself so we don't have to shim the entire safe-area native module.
vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => ({ walletBalance: null, isWalletUser: false }),
  QuotaInfoSheet: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
// expo-document-picker and expo-file-system pull in expo-modules-core which
// requires React Native native globals (__DEV__, EventEmitter, etc.) that jsdom
// never provides. Mock both at the module level so the screen can be imported.
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(async () => ({ canceled: true, assets: [] })),
}));
vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  uploadAsync: vi.fn(async () => ({ status: 200, body: "{}" })),
  readAsStringAsync: vi.fn(async () => ""),
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: "multipart" },
}));

import BrandVoiceScreen from "../app/brand-voice";
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
  playerMock.replace.mockReset();
  playerMock.play.mockReset();
  // Reset upload-chain mocks so call counts don't bleed between tests.
  requestUploadMutateAsync.mockReset();
  cloneVoiceMutateAsync.mockReset();
  getDocumentAsync.mockReset();
  uploadAsync.mockReset();

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
    mockState.payload = {
      ...JSON.parse(JSON.stringify(basePayload)),
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
    await act(async () => {
      opts.onSuccess({ audioPath: "/objects/t/out.mp3" });
    });

    // Notice and Play/Share buttons should now be visible.
    await waitFor(() => expect(screen.getByText("Audio ready — playing now.")).toBeTruthy());
    expect(screen.getByText("Play again")).toBeTruthy();
    expect(screen.getByText("Share / Save")).toBeTruthy();
  });

  it("error path: mutation failure shows an error notice and does not show Play/Share buttons", async () => {
    mockState.payload = {
      ...JSON.parse(JSON.stringify(basePayload)),
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
    opts.onError({ data: { error: "Voice provider unavailable." } });

    // Error notice should be visible.
    await waitFor(() =>
      expect(screen.getByText("Voice provider unavailable.")).toBeTruthy(),
    );

    // Play/Share buttons must NOT appear.
    expect(screen.queryByText("Play again")).toBeNull();
    expect(screen.queryByText("Share / Save")).toBeNull();
  });

  it("shows cloned state with preview and confirm-gated remove", async () => {
    mockState.payload = {
      ...JSON.parse(JSON.stringify(basePayload)),
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
    // The apiErrorMessage helper extracts .data.error; must be surfaced to the user.
    expect(errText).toMatch(/quota exceeded/i);
  });

  it("shows a fallback error message when the clone POST throws a generic error", async () => {
    cloneVoiceMutateAsync.mockRejectedValue(new Error("Failed to fetch"));

    renderScreen();
    await openCloneAndPickFile();

    await waitFor(() =>
      expect(screen.getByTestId("text-record-error")).toBeTruthy(),
    );
    const errText = screen.getByTestId("text-record-error").textContent ?? "";
    // The apiErrorMessage helper extracts .data.error; must be surfaced to the user.
    expect(errText).toMatch(/quota exceeded/i);
  });

  it("shows a fallback error message when the clone POST throws a generic error", async () => {
    cloneVoiceMutateAsync.mockRejectedValue(new Error("Failed to fetch"));

    renderScreen();
    await openCloneAndPickFile();

    await waitFor(() =>
      expect(screen.getByTestId("text-record-error")).toBeTruthy(),
    );
    const errText = screen.getByTestId("text-record-error").textContent ?? "";
    // The apiErrorMessage helper extracts .data.error; must be surfaced to the user.
    expect(errText).toMatch(/quota exceeded/i);
  });

  it("shows a fallback error message when the clone POST throws a generic error", async () => {
    cloneVoiceMutateAsync.mockRejectedValue(new Error("Failed to fetch"));

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

describe("performUpload — unmount mid-upload", () => {
  it("does not show an error or crash after unmounting during the presigned URL request", async () => {
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
