/**
 * Mobile Brand Voice screen (task parity with the web Brand Kit voice section):
 * - shows the cloned-voice state with preview + remove, or the stock-voice note
 * - shows clear messaging when the feature is off or unconfigured
 * - saving a stock voice / delivery style creates a new ACTIVATED kit version
 *   from a deep clone of the active payload (other sections preserved)
 * - remove goes through an in-app confirm dialog (no native confirm).
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const previewMutate = vi.fn();
const removeMutate = vi.fn();
const createVersionMutate = vi.fn();
const createAudioMutate = vi.fn();
const playerMock = { replace: vi.fn(), play: vi.fn(), seekTo: vi.fn() };

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
  useAudioRecorder: () => ({
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    uri: null,
  }),
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true }),
}));
vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
  uploadAsync: vi.fn().mockResolvedValue({ status: 200 }),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
}));
vi.mock("@/lib/haptics", () => ({ haptic: () => {} }));

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

beforeEach(() => {
  cleanup();
  previewMutate.mockReset();
  removeMutate.mockReset();
  createVersionMutate.mockReset();
  createAudioMutate.mockReset();
  playerMock.replace.mockReset();
  playerMock.play.mockReset();
  mockState.status = { enabled: true, configured: true, provider: "elevenlabs" };
  mockState.kits = [{ id: 5, name: "Kokao", isDefault: true, isArchived: false }];
  mockState.payload = JSON.parse(JSON.stringify(basePayload));
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

    // Click the Generate audio button (distinct from the "Generate audio" section heading).
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
