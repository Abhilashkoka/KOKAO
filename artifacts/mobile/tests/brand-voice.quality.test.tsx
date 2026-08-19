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

vi.mock("@expo/vector-icons", () => ({
  Feather: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

// Shared mock recorder whose behaviour each test can customise.
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

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true }),
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
    useWalletGetOverview: () => ({ data: null, isLoading: false }),
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
    const samples = Array<number>(10).fill(-60);
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual(["too-quiet"]);
  });

  it("stops after too-quiet and does not also flag noise on a silent track", () => {
    const samples = Array<number>(10).fill(-60);
    const issues = analyzeVoiceSampleFromMetering(samples);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe("too-quiet");
  });

  it("does not flag too-quiet for a normal speech level", () => {
    // -20 dBFS → amplitude = 10^(-1) = 0.1, well above METERING_MIN_AMP (0.01).
    // Normal conversational recording — must not trigger any quiet warning.
    const samples = Array<number>(10).fill(-20);
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("too-quiet");
  });

  // ── clipped ────────────────────────────────────────────────────────────────
  it("detects clipped when more than 1 % of readings exceed the clip threshold", () => {
    // METERING_CLIP_AMP = 10^(-1/20) ≈ 0.891 → corresponds to ≈ -0.5 dBFS.
    // 2 clipped out of 10 = 20 % > 1 % threshold.
    // Remaining 8 at -20 dBFS keep mean well above zero (not quiet).
    const samples = [...Array<number>(2).fill(-0.5), ...Array<number>(8).fill(-20)];
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual(["clipped"]);
  });

  it("stops after clipped and does not also flag noise on a distorted track", () => {
    const samples = [...Array<number>(2).fill(-0.5), ...Array<number>(8).fill(-20)];
    const issues = analyzeVoiceSampleFromMetering(samples);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe("clipped");
  });

  it("does not flag clipped when the ratio is at or below 1 %", () => {
    // Exactly 1 out of 100 clipped = 1 % → NOT flagged (threshold is strictly >).
    const samples = [-0.5, ...Array<number>(99).fill(-20)];
    expect(analyzeVoiceSampleFromMetering(samples)).not.toContain("clipped");
  });

  // ── noisy ──────────────────────────────────────────────────────────────────
  it("detects noisy when the noise-floor / speech-level ratio exceeds the threshold", () => {
    // 8 readings at -20 dBFS (amp 0.100) as noise floor
    // 2 readings at -10 dBFS (amp ≈ 0.316) as speech peaks
    // Sorted ascending: [0.1 × 8, 0.316 × 2]; tail = floor(10 × 0.2) = 2
    // noiseFloor = mean(bottom 2) = 0.100; speechLevel = mean(top 2) ≈ 0.316
    // Ratio ≈ 0.316 > METERING_MAX_NOISE_RATIO (0.25) ✓
    // noiseFloor 0.100 >= METERING_MIN_NOISE_FLOOR_AMP (0.02) ✓
    const samples = [...Array<number>(8).fill(-20), ...Array<number>(2).fill(-10)];
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual(["noisy"]);
  });

  it("does not flag noisy when the noise floor is below the absolute minimum amplitude", () => {
    // -40 dBFS → amplitude ≈ 0.010; METERING_MIN_NOISE_FLOOR_AMP = 0.02.
    // The ratio check is gated on noiseFloor >= 0.02, so even a high ratio won't fire.
    const samples = [...Array<number>(8).fill(-40), ...Array<number>(2).fill(-10)];
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
    expect(analyzeVoiceSampleFromMetering(samples)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Integration test — stopRecording path → sampleWarning
// ══════════════════════════════════════════════════════════════════════════════

describe("stopRecording → sampleWarning integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset shared recorder for each test.
    mockRecorder.prepareToRecordAsync.mockResolvedValue(undefined);
    mockRecorder.record.mockReset();
    mockRecorder.stop.mockResolvedValue(undefined);
    mockRecorder.uri = "file:///recording.m4a";
    // Default: near-silent → too-quiet.
    mockRecorder.getStatus.mockReturnValue({ metering: -60 });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("sets sampleWarning with quality issues detected from metering data", async () => {
    // Metering readings at -60 dBFS → amplitude ≈ 0.001, mean < METERING_MIN_AMP → too-quiet.
    mockRecorder.getStatus.mockReturnValue({ metering: -60 });

    render(<BrandVoiceScreen />);

    // The component renders synchronously because all mocked queries return data immediately.
    // Open the clone voice modal.
    fireEvent.click(screen.getByText("Clone your voice"));

    // Start recording. startRecording() is async; flush its three internal awaits
    // (requestRecordingPermissionsAsync, setAudioModeAsync, prepareToRecordAsync).
    // Each resolved mock promise needs one microtask drain — use act + promise chain.
    await act(async () => {
      fireEvent.click(screen.getByText("Record a sample"));
      // Three awaits inside startRecording, plus one for the finally block.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance 25 seconds: the 250 ms setInterval fires 100 times, each pushing a
    // metering sample of -60 dBFS into meteringRef.current. Date.now() advances in
    // lockstep (vi.useFakeTimers mocks Date), so elapsed = 25 s >= MIN (20 s).
    act(() => {
      vi.advanceTimersByTime(25_000);
    });

    // "Stop recording" button must now be visible.
    expect(screen.getByText("Stop recording")).toBeTruthy();

    // Stop recording and flush the two internal awaits (recorder.stop, getInfoAsync).
    // waitFor is intentionally avoided here: it uses setTimeout internally and would
    // deadlock with fake timers. Act + promise chains are the correct substitute.
    await act(async () => {
      fireEvent.click(screen.getByText("Stop recording"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The sample-warning modal must now be visible with the too-quiet issue.
    expect(screen.getByText("This sample may produce a poor clone")).toBeTruthy();

    // The per-issue text element is rendered with its testID.
    expect(screen.getByTestId("text-sample-issue-too-quiet")).toBeTruthy();

    // Both action buttons must be present so the user can choose.
    expect(screen.getByText("Upload anyway")).toBeTruthy();
    expect(screen.getByText("Choose another")).toBeTruthy();
  });
});
