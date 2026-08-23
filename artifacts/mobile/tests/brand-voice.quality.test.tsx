// @vitest-environment jsdom
/**
 * Brand Voice recording quality tests.
 *
 * 1. Unit tests for analyzeVoiceSampleFromMetering (pure function).
 * 2. Integration test: stopRecording path → sampleWarning set when
 *    metering data indicates a quality issue.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// ─── Mocks (all before module imports so vi.mock hoisting works) ──────────────

const mockRecorder = {
  prepareToRecordAsync: vi.fn().mockResolvedValue(undefined),
  record: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  /** Override metering per-test via mockReturnValue. */
  getStatus: vi.fn().mockReturnValue({ metering: -20 }),
  uri: "file:///recording.m4a" as string | null,
};

vi.mock("expo-audio", () => ({
  useAudioRecorder: () => mockRecorder,
  useAudioPlayer: () => ({ replace: vi.fn(), seekTo: vi.fn(), play: vi.fn(), pause: vi.fn(), remove: vi.fn() }),
  useAudioPlayerStatus: () => ({ playing: false }),
  RecordingPresets: { HIGH_QUALITY: { isMeteringEnabled: true } },
  requestRecordingPermissionsAsync: vi.fn().mockResolvedValue({ granted: true }),
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
}));

const mockDocumentPicker = vi.fn().mockResolvedValue({ canceled: true });

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: (...args: unknown[]) => mockDocumentPicker(...args),
}));

vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
  uploadAsync: vi.fn().mockResolvedValue({ status: 200 }),
  FileSystemUploadType: { BINARY_CONTENT: 1 },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => false,
}));

vi.mock("@/components/ui", () => ({
  Button: ({ title, onPress, testID, disabled, loading }: {
    title: string; onPress?: () => void; testID?: string; disabled?: boolean; loading?: boolean;
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

// RazorpayCheckoutModal pulls in react-native-webview which is incompatible
// with jsdom. Stub it to a no-op so the import chain doesn't crash.
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: () => null,
  useRazorpayWalletRecharge: () => ({ open: vi.fn(), isOpen: false }),
}));

const mockKit = { id: 1, name: "My Kit", isDefault: true, isArchived: false };
const mockDetail = {
  id: 1,
  name: "My Kit",
  isDefault: true,
  isArchived: false,
  activeVersion: { payload: { brand_voice: null } },
};
const mockRequestUploadUrl = {
  mutateAsync: vi.fn().mockResolvedValue({
    uploadURL: "https://storage.example/upload/sample",
    objectPath: "/objects/1/voice-samples/sample",
  }),
  isPending: false,
};
const mockCheckBrandVoiceSample = {
  mutateAsync: vi.fn().mockResolvedValue({ issues: ["too-quiet"] }),
};
const mockDeleteBrandVoiceSample = {
  mutateAsync: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({
      data: [mockKit],
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
    useRequestUploadUrl: () => mockRequestUploadUrl,
    useCheckBrandVoiceSample: () => mockCheckBrandVoiceSample,
    useDeleteBrandVoiceSample: () => mockDeleteBrandVoiceSample,
    useWalletGetOverview: () => ({ data: null, isLoading: false }),
    useRequestUploadUrl: () => ({
      mutateAsync: requestUploadUrlMutateAsync,
      isPending: false,
    }),
    useCloneBrandVoice: () => ({
      mutateAsync: cloneVoiceMutateAsync,
      isPending: false,
    }),
  });
});

// ─── Imports of code under test ───────────────────────────────────────────────

import { analyzeVoiceSampleFromMetering } from "../app/brand-voice";
import BrandVoiceScreen from "../app/brand-voice";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Unit tests — analyzeVoiceSampleFromMetering (pure function)
// ══════════════════════════════════════════════════════════════════════════════

describe("analyzeVoiceSampleFromMetering", () => {
  it("returns no issues when fewer than 4 samples are provided (guard)", () => {
    expect(analyzeVoiceSampleFromMetering([])).toEqual([]);
    expect(analyzeVoiceSampleFromMetering([-20])).toEqual([]);
    expect(analyzeVoiceSampleFromMetering([-20, -25, -30])).toEqual([]);
  });

  it("returns no issues for exactly 3 samples even if they would be problematic", () => {
    // Three near-silent readings — fewer than 4 so the guard short-circuits.
    expect(analyzeVoiceSampleFromMetering([-80, -80, -80])).toEqual([]);
  });

  // ── too-quiet ──────────────────────────────────────────────────────────────
  it("detects too-quiet when the mean amplitude is below the minimum threshold", () => {
    // -60 dBFS → amplitude = 10^(-60/20) = 0.001, well below METERING_MIN_AMP (0.01)
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  // ── clean ─────────────────────────────────────────────────────────────────
  it("returns no issues for a clean, well-levelled recording", () => {
    // 8 readings at -40 dBFS (amp ≈ 0.010) as very quiet pauses
    // 2 readings at  -6 dBFS (amp ≈ 0.501) as speech peaks
    // Mean ≈ (8×0.010 + 2×0.501)/10 = 0.108 → not quiet.
    // No readings reach the clip threshold (0.501 < 0.891).
    // noiseFloor ≈ 0.010 < METERING_MIN_NOISE_FLOOR_AMP (0.02) → no noisy.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    const issues = analyzeVoiceSampleFromMetering(samples);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe("clipped");
  });

  it("does not flag clipped when the ratio is at or below 1 %", () => {
    // Exactly 1 out of 100 clipped = 1 % → NOT flagged (threshold is strictly >).
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  // ── clean ─────────────────────────────────────────────────────────────────
  it("returns no issues for a clean, well-levelled recording", () => {
    // 8 readings at -40 dBFS (amp ≈ 0.010) as very quiet pauses
    // 2 readings at  -6 dBFS (amp ≈ 0.501) as speech peaks
    // Mean ≈ (8×0.010 + 2×0.501)/10 = 0.108 → not quiet.
    // No readings reach the clip threshold (0.501 < 0.891).
    // noiseFloor ≈ 0.010 < METERING_MIN_NOISE_FLOOR_AMP (0.02) → no noisy.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  // ── clean ─────────────────────────────────────────────────────────────────
  it("returns no issues for a clean, well-levelled recording", () => {
    // 8 readings at -40 dBFS (amp ≈ 0.010) as very quiet pauses
    // 2 readings at  -6 dBFS (amp ≈ 0.501) as speech peaks
    // Mean ≈ (8×0.010 + 2×0.501)/10 = 0.108 → not quiet.
    // No readings reach the clip threshold (0.501 < 0.891).
    // noiseFloor ≈ 0.010 < METERING_MIN_NOISE_FLOOR_AMP (0.02) → no noisy.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    const issues = analyzeVoiceSampleFromMetering(samples);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe("clipped");
  });

  it("does not flag clipped when the ratio is at or below 1 %", () => {
    // Exactly 1 out of 100 clipped = 1 % → NOT flagged (threshold is strictly >).
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  // ── clean ─────────────────────────────────────────────────────────────────
  it("returns no issues for a clean, well-levelled recording", () => {
    // 8 readings at -40 dBFS (amp ≈ 0.010) as very quiet pauses
    // 2 readings at  -6 dBFS (amp ≈ 0.501) as speech peaks
    // Mean ≈ (8×0.010 + 2×0.501)/10 = 0.108 → not quiet.
    // No readings reach the clip threshold (0.501 < 0.891).
    // noiseFloor ≈ 0.010 < METERING_MIN_NOISE_FLOOR_AMP (0.02) → no noisy.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  // ── clean ─────────────────────────────────────────────────────────────────
  it("returns no issues for a clean, well-levelled recording", () => {
    // 8 readings at -40 dBFS (amp ≈ 0.010) as very quiet pauses
    // 2 readings at  -6 dBFS (amp ≈ 0.501) as speech peaks
    // Mean ≈ (8×0.010 + 2×0.501)/10 = 0.108 → not quiet.
    // No readings reach the clip threshold (0.501 < 0.891).
    // noiseFloor ≈ 0.010 < METERING_MIN_NOISE_FLOOR_AMP (0.02) → no noisy.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("noisy");
  });

  // ── clean ─────────────────────────────────────────────────────────────────
  it("returns no issues for a clean, well-levelled recording", () => {
    // 8 readings at -40 dBFS (amp ≈ 0.010) as very quiet pauses
    // 2 readings at  -6 dBFS (amp ≈ 0.501) as speech peaks
    // Mean ≈ (8×0.010 + 2×0.501)/10 = 0.108 → not quiet.
    // No readings reach the clip threshold (0.501 < 0.891).
    // noiseFloor ≈ 0.010 < METERING_MIN_NOISE_FLOOR_AMP (0.02) → no noisy.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-6)];

    const cleanReadings = [
      ...Array<number>(8).fill(-40),
      ...Array<number>(2).fill(-6),
    ];
    mockRecorder.uri = "file:///fresh-recording.m4a";
    mockRecorder.getStatus.mockImplementation(() => ({
      metering: cleanReadings[readingIndex++ % cleanReadings.length],
    }));

    await act(async () => {
      fireEvent.click(screen.getByText("Record a sample"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRecorder.record).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Stop recording"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fresh readings clear quality checks, then upload only the new take.
    expect(screen.queryByText("This sample may produce a poor clone")).toBeNull();
    expect(fileUploadAsync).toHaveBeenCalledWith(
      "https://uploads.example.test/voice-sample",
      "file:///fresh-recording.m4a",
      expect.any(Object),
    );
    expect(fileUploadAsync).not.toHaveBeenCalledWith(
      expect.any(String),
      "file:///recording.m4a",
      expect.any(Object),
    );
  });
});

describe("picked sample warning cleanup", () => {
  beforeEach(() => {
    mockDocumentPicker.mockReset();
    mockRequestUploadUrl.mutateAsync.mockClear();
    mockCheckBrandVoiceSample.mutateAsync.mockClear();
    mockDeleteBrandVoiceSample.mutateAsync.mockClear();
    mockDocumentPicker.mockResolvedValue({
      canceled: false,
      assets: [{
        uri: "file:///picked-sample.mp3",
        name: "picked-sample.mp3",
        mimeType: "audio/mpeg",
        size: 1_024,
      }],
    });
    mockRequestUploadUrl.mutateAsync.mockResolvedValue({
      uploadURL: "https://storage.example/upload/sample",
      objectPath: "/objects/1/voice-samples/sample",
    });
    mockCheckBrandVoiceSample.mutateAsync.mockResolvedValue({ issues: ["too-quiet"] });
    mockDeleteBrandVoiceSample.mutateAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("deletes an uploaded picked sample when the user chooses another", async () => {
    render(<BrandVoiceScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Clone your voice"));
    await act(async () => {
      fireEvent.click(screen.getByText("Pick an audio file"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("This sample may produce a poor clone")).toBeTruthy();
    fireEvent.click(screen.getByText("Choose another"));

    expect(mockDeleteBrandVoiceSample.mutateAsync).toHaveBeenCalledWith({
      data: { sampleAssetPath: "/objects/1/voice-samples/sample" },
    });
  });

  it("does not surface a cleanup failure when the warning is dismissed", async () => {
    mockDeleteBrandVoiceSample.mutateAsync.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    render(<BrandVoiceScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Clone your voice"));
    await act(async () => {
      fireEvent.click(screen.getByText("Pick an audio file"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText("Choose another"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockDeleteBrandVoiceSample.mutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("text-record-error")).toBeNull();
  });
});

const {
  fileUploadAsync,
  requestUploadUrlMutateAsync,
  cloneVoiceMutateAsync,
} = vi.hoisted(() => ({
  fileUploadAsync: vi.fn(),
  requestUploadUrlMutateAsync: vi.fn(),
  cloneVoiceMutateAsync: vi.fn(),
}));

    let readingIndex = 0;

  const actual = await importOriginal<typeof import("react-native")>();
