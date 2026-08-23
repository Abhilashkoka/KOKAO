// @vitest-environment jsdom
/**
 * Brand Voice sample-quality tests.
 *
 * Covers the pure metering analysis plus the warning actions for recorded and
 * picked samples.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const {
  mockRecorder,
  getDocumentAsync,
  getInfoAsync,
  uploadAsync,
  requestUploadUrlMutateAsync,
  checkBrandVoiceSampleMutateAsync,
  deleteBrandVoiceSampleMutateAsync,
  cloneVoiceMutateAsync,
  mockDetail,
} = vi.hoisted(() => ({
  mockRecorder: {
    prepareToRecordAsync: vi.fn().mockResolvedValue(undefined),
    record: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ metering: -20 }),
    uri: "file:///recording.m4a" as string | null,
  },
  getDocumentAsync: vi.fn(),
  getInfoAsync: vi.fn(),
  uploadAsync: vi.fn(),
  requestUploadUrlMutateAsync: vi.fn(),
  checkBrandVoiceSampleMutateAsync: vi.fn(),
  deleteBrandVoiceSampleMutateAsync: vi.fn(),
  cloneVoiceMutateAsync: vi.fn(),
  mockDetail: {
    id: 1,
    name: "My Kit",
    isDefault: true,
    isArchived: false,
    activeVersion: {
      payload: {
        brand_voice: null as Record<string, string> | null,
      },
    },
  },
}));

vi.mock("@expo/vector-icons", () => ({
  Feather: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

vi.mock("expo-audio", () => ({
  useAudioRecorder: () => mockRecorder,
  useAudioPlayer: () => ({
    replace: vi.fn(),
    seekTo: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    remove: vi.fn(),
  }),
  useAudioPlayerStatus: () => ({ playing: false }),
  RecordingPresets: { HIGH_QUALITY: { isMeteringEnabled: true } },
  requestRecordingPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("expo-document-picker", () => ({
  getDocumentAsync,
}));

vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync,
  uploadAsync,
  FileSystemUploadType: { BINARY_CONTENT: 1 },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => false,
}));

vi.mock("@/components/ui", () => ({
  Button: ({
    title,
    onPress,
    testID,
    disabled,
    loading,
  }: {
    title: string;
    onPress?: () => void;
    testID?: string;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button data-testid={testID} onClick={onPress} disabled={!!(disabled || loading)}>
      {title}
    </button>
  ),
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Chip: ({ label, onPress }: { label: string; onPress?: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  ErrorState: ({ message, onRetry }: { message?: string; onRetry?: () => void }) => (
    <div>
      {message}
      <button onClick={onRetry}>Retry</button>
    </div>
  ),
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("@/constants/colors", () => ({
  default: {
    light: {
      primary: "#000",
      background: "#fff",
      foreground: "#111",
      muted: "#eee",
      mutedForeground: "#666",
      border: "#ddd",
      accent: "#f5f5f5",
    },
    radius: 8,
  },
}));

vi.mock("@/constants/fonts", () => ({
  fonts: { regular: "System", medium: "System", semiBold: "System" },
}));

vi.mock("@/lib/apiErrorMessage", () => ({
  apiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

vi.mock("@/lib/haptics", () => ({
  haptic: vi.fn(),
}));

vi.mock("@/lib/verifyFailureNotice", () => ({
  verifyFailureNotice: vi.fn().mockReturnValue(null),
}));

vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: () => null,
  useRazorpayWalletRecharge: () => ({ open: vi.fn(), isOpen: false }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({
      data: [{ id: 1, name: "My Kit", isDefault: true, isArchived: false }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useGetBrandKit: () => ({
      data: mockDetail,
      isLoading: false,
      isFetching: false,
    }),
    useGetBrandVoiceStatus: () => ({
      data: { enabled: true, configured: true },
      isLoading: false,
    }),
    useWalletGetOverview: () => ({ data: null, isLoading: false }),
    useRequestUploadUrl: () => ({
      mutateAsync: requestUploadUrlMutateAsync,
      isPending: false,
    }),
    useCheckBrandVoiceSample: () => ({
      mutateAsync: checkBrandVoiceSampleMutateAsync,
    }),
    useDeleteBrandVoiceSample: () => ({
      mutateAsync: deleteBrandVoiceSampleMutateAsync,
    }),
    useCloneBrandVoice: () => ({
      mutateAsync: cloneVoiceMutateAsync,
      isPending: false,
    }),
  });
});

import BrandVoiceScreen, { analyzeVoiceSampleFromMetering } from "../app/brand-voice";

function setClonedVoice(sampleAssetPath: string) {
  mockDetail.activeVersion.payload.brand_voice = {
    mode: "cloned",
    provider: "elevenlabs",
    provider_voice_id: "voice-123",
    preset_voice: "alloy",
    delivery_style: "",
    sample_asset_path: sampleAssetPath,
    cloned_label: "My Kit voice",
    cloned_at: "2026-08-23T00:00:00.000Z",
  };
}

function findExitingModalLayer(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    if (window.getComputedStyle(current).pointerEvents === "none") return current;
    current = current.parentElement;
  }
  return null;
}

describe("analyzeVoiceSampleFromMetering", () => {
  it("returns no issues when fewer than 4 samples are provided", () => {
    expect(analyzeVoiceSampleFromMetering([])).toEqual([]);
    expect(analyzeVoiceSampleFromMetering([-20])).toEqual([]);
    expect(analyzeVoiceSampleFromMetering([-20, -25, -30])).toEqual([]);
  });

  it("returns no issues for exactly 3 problematic samples", () => {
    expect(analyzeVoiceSampleFromMetering([-80, -80, -80])).toEqual([]);
  });

  it("detects a sample that is too quiet", () => {
    expect(analyzeVoiceSampleFromMetering(Array<number>(10).fill(-60))).toEqual([
      "too-quiet",
    ]);
  });

  it("does not also flag noise on a silent track", () => {
    const issues = analyzeVoiceSampleFromMetering(Array<number>(10).fill(-60));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe("too-quiet");
  });

  it("does not flag normal speech as too quiet", () => {
    expect(analyzeVoiceSampleFromMetering(Array<number>(10).fill(-20))).not.toContain(
      "too-quiet",
    );
  });

  it("detects clipped audio", () => {
    const samples = [...Array<number>(2).fill(-0.5), ...Array<number>(8).fill(-20)];
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual(["clipped"]);
  });

  it("does not also flag noise on a clipped track", () => {
    const samples = [...Array<number>(2).fill(-0.5), ...Array<number>(8).fill(-20)];
    const issues = analyzeVoiceSampleFromMetering(samples);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe("clipped");
  });

  it("does not flag clipping at or below the 1 percent threshold", () => {
    const samples = [-0.5, ...Array<number>(99).fill(-20)];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("clipped");
  });

  it("detects a high background-noise ratio", () => {
    const samples = [...Array<number>(8).fill(-20), ...Array<number>(2).fill(-10)];
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual(["noisy"]);
  });

  it("does not flag noise below the absolute noise-floor threshold", () => {
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-10)];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  it("returns no issues for a clean, well-levelled recording", () => {
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual([]);
  });
});

describe("recorded sample quality warning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    mockDetail.activeVersion.payload.brand_voice = null;
    mockRecorder.prepareToRecordAsync.mockResolvedValue(undefined);
    mockRecorder.record.mockReset();
    mockRecorder.stop.mockResolvedValue(undefined);
    mockRecorder.getStatus.mockReturnValue({ metering: -60 });
    mockRecorder.uri = "file:///recording.m4a";
    getInfoAsync.mockReset();
    getInfoAsync.mockResolvedValue({ exists: true, size: 24_576 });
    uploadAsync.mockReset();
    uploadAsync.mockResolvedValue({ status: 200, body: "" });
    requestUploadUrlMutateAsync.mockReset();
    requestUploadUrlMutateAsync.mockResolvedValue({
      uploadURL: "https://storage.example/upload/recording",
      objectPath: "/objects/1/voice-samples/recording.m4a",
    });
    cloneVoiceMutateAsync.mockReset();
    cloneVoiceMutateAsync.mockResolvedValue(undefined);
    checkBrandVoiceSampleMutateAsync.mockReset();
    deleteBrandVoiceSampleMutateAsync.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  async function recordQuietSampleUntilWarning() {
    render(<BrandVoiceScreen />);
    fireEvent.click(screen.getByText("Clone your voice"));

    await act(async () => {
      fireEvent.click(screen.getByText("Record a sample"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(25_000);
    });

    expect(screen.getByText("Stop recording")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Stop recording"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("shows the metering quality issue and both warning actions", async () => {
    await recordQuietSampleUntilWarning();

    expect(screen.getByText("This sample may produce a poor clone")).toBeTruthy();
    expect(screen.getByTestId("text-sample-issue-too-quiet")).toBeTruthy();
    expect(screen.getByText("Upload anyway")).toBeTruthy();
    expect(screen.getByText("Choose another")).toBeTruthy();
  });

  it("uploads the original recording and clones it after Upload anyway", async () => {
    cloneVoiceMutateAsync.mockImplementation(
      async ({ data }: { data: { sampleAssetPath: string } }) => {
        setClonedVoice(data.sampleAssetPath);
      },
    );

    await recordQuietSampleUntilWarning();
    await act(async () => {
      fireEvent.click(screen.getByText("Upload anyway"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      findExitingModalLayer(screen.getByText("This sample may produce a poor clone")),
    ).toBeTruthy();
    expect(requestUploadUrlMutateAsync).toHaveBeenCalledTimes(1);
    expect(requestUploadUrlMutateAsync).toHaveBeenCalledWith({
      data: {
        name: "voice-sample.m4a",
        size: 24_576,
        contentType: "audio/mp4",
        purpose: "brand-voice-sample",
      },
    });
    expect(uploadAsync).toHaveBeenCalledWith(
      "https://storage.example/upload/recording",
      "file:///recording.m4a",
      expect.objectContaining({
        httpMethod: "PUT",
        headers: { "Content-Type": "audio/mp4" },
      }),
    );
    expect(cloneVoiceMutateAsync).toHaveBeenCalledWith({
      id: 1,
      data: {
        sampleAssetPath: "/objects/1/voice-samples/recording.m4a",
        label: "My Kit voice",
      },
    });
    expect(findExitingModalLayer(screen.getByText("Record a sample"))).toBeTruthy();
    expect(screen.getByText("Cloned voice active")).toBeTruthy();
  });
});

describe("picked sample quality warning", () => {
  beforeEach(() => {
    cleanup();
    mockDetail.activeVersion.payload.brand_voice = null;
    getDocumentAsync.mockReset();
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///picked-sample.mp3",
          name: "picked-sample.mp3",
          mimeType: "audio/mpeg",
          size: 1_024,
        },
      ],
    });
    uploadAsync.mockReset();
    uploadAsync.mockResolvedValue({ status: 200, body: "" });
    requestUploadUrlMutateAsync.mockReset();
    requestUploadUrlMutateAsync.mockResolvedValue({
      uploadURL: "https://storage.example/upload/sample",
      objectPath: "/objects/1/voice-samples/sample",
    });
    checkBrandVoiceSampleMutateAsync.mockReset();
    checkBrandVoiceSampleMutateAsync.mockResolvedValue({ issues: ["too-quiet"] });
    deleteBrandVoiceSampleMutateAsync.mockReset();
    deleteBrandVoiceSampleMutateAsync.mockResolvedValue(undefined);
    cloneVoiceMutateAsync.mockReset();
    cloneVoiceMutateAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  async function pickSampleUntilWarning() {
    render(<BrandVoiceScreen />);
    fireEvent.click(screen.getByText("Clone your voice"));
    await act(async () => {
      fireEvent.click(screen.getByText("Pick an audio file"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("This sample may produce a poor clone")).toBeTruthy();
  }

  it("deletes the uploaded sample when the user chooses another", async () => {
    await pickSampleUntilWarning();
    fireEvent.click(screen.getByText("Choose another"));

    expect(
      findExitingModalLayer(screen.getByText("This sample may produce a poor clone")),
    ).toBeTruthy();
    expect(deleteBrandVoiceSampleMutateAsync).toHaveBeenCalledWith({
      data: { sampleAssetPath: "/objects/1/voice-samples/sample" },
    });
  });

  it("does not surface a cleanup failure when the warning is dismissed", async () => {
    deleteBrandVoiceSampleMutateAsync.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await pickSampleUntilWarning();
    fireEvent.click(screen.getByText("Choose another"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(deleteBrandVoiceSampleMutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("text-record-error")).toBeNull();
  });

  it("clones the stored path without uploading or checking the file again", async () => {
    cloneVoiceMutateAsync.mockImplementation(
      async ({ data }: { data: { sampleAssetPath: string } }) => {
        setClonedVoice(data.sampleAssetPath);
      },
    );

    await pickSampleUntilWarning();
    expect(requestUploadUrlMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadAsync).toHaveBeenCalledTimes(1);
    expect(checkBrandVoiceSampleMutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText("Upload anyway"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      findExitingModalLayer(screen.getByText("This sample may produce a poor clone")),
    ).toBeTruthy();
    expect(cloneVoiceMutateAsync).toHaveBeenCalledTimes(1);
    expect(cloneVoiceMutateAsync).toHaveBeenCalledWith({
      id: 1,
      data: {
        sampleAssetPath: "/objects/1/voice-samples/sample",
        label: "My Kit voice",
      },
    });
    expect(requestUploadUrlMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadAsync).toHaveBeenCalledTimes(1);
    expect(checkBrandVoiceSampleMutateAsync).toHaveBeenCalledTimes(1);
    expect(deleteBrandVoiceSampleMutateAsync).not.toHaveBeenCalled();
    expect(findExitingModalLayer(screen.getByText("Record a sample"))).toBeTruthy();
    expect(screen.getByText("Cloned voice active")).toBeTruthy();
  });
});