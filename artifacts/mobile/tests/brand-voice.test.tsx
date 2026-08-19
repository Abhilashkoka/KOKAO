/**
 * Guard: audio cost estimate on the Brand Voice screen.
 *
 * The estimate and shortfall warning are gated by three conditions:
 *   - walletBilling must be true (tenant is on prepaid wallet billing)
 *   - captionPaise must be > 0 (rate is configured)
 *   - audioScript must be non-empty
 *
 * Tests confirm the estimate renders and hides correctly under each condition.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Lightweight mocks for native / third-party modules ────────────────────────

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: () => Promise.resolve("tok") }),
}));

vi.mock("expo-audio", () => ({
  useAudioPlayer: () => ({
    replace: vi.fn(),
    seekTo: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    remove: vi.fn(),
  }),
  useAudioPlayerStatus: () => ({ playing: false }),
  useAudioRecorder: () => ({
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    uri: null,
    getStatus: () => ({}),
  }),
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: vi.fn(),
  setAudioModeAsync: vi.fn(),
}));

vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-file-system/legacy", () => ({ getInfoAsync: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/lib/verifyFailureNotice", () => ({
  verifyFailureNotice: vi.fn().mockReturnValue(null),
}));
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: () => null,
  useRazorpayWalletRecharge: () => ({ open: vi.fn(), isOpen: false }),
}));
vi.mock("@/lib/apiErrorMessage", () => ({
  apiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

vi.mock("@/constants/colors", () => ({
  default: {
    light: {
      primary: "#6d3bec",
      background: "#fff",
      foreground: "#000",
      card: "#fafafa",
      cardForeground: "#000",
      muted: "#f4f4f5",
      mutedForeground: "#71717a",
      secondary: "#f4f4f5",
      secondaryForeground: "#18181b",
      accent: "#f1ebfe",
      accentForeground: "#4c1fb8",
      border: "#e4e4e7",
      destructive: "#ef4444",
      destructiveForeground: "#fff",
      text: "#0a0a0a",
      tint: "#6d3bec",
    },
  },
}));

vi.mock("@/constants/fonts", () => ({
  fonts: {
    regular: "System",
    medium: "System",
    semiBold: "System",
    bold: "System",
  },
}));

vi.mock("@/components/ui", () => ({
  Button: ({
    title,
    onPress,
    testID,
  }: {
    title: string;
    onPress?: () => void;
    testID?: string;
  }) => <button onClick={onPress} data-testid={testID}>{title}</button>,
  Card: ({ children, style: _s }: { children: React.ReactNode; style?: unknown }) => (
    <div>{children}</div>
  ),
  Chip: ({
    label,
    onPress,
  }: {
    label: string;
    selected?: boolean;
    onPress?: () => void;
  }) => <button onClick={onPress}>{label}</button>,
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Skeleton: () => null,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  ErrorState: ({ message }: { message?: string }) => <div>{message}</div>,
}));

// ── State shared between mock hooks and individual tests ──────────────────────

type WalletOverviewData = {
  walletBilling: boolean;
  balancePaise: number;
  rates: { captionPaise: number };
} | null;

const mockState: {
  walletBilling: boolean;
  walletOverview: WalletOverviewData;
} = {
  walletBilling: true,
  walletOverview: { walletBilling: true, balancePaise: 1000, rates: { captionPaise: 500 } },
};

// Mock useWalletBilling from QuotaInfoSheet independently of the api-client.
vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => mockState.walletBilling,
  // Export a minimal QuotaInfoSheet so the import doesn't crash.
  QuotaInfoSheet: () => null,
  QuotaErrorNotice: () => null,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({
      data: [{ id: 1, name: "My Kit", isDefault: true, isArchived: false }],
      isLoading: false,
      isError: false,
    }),
    useGetBrandKit: () => ({
      data: {
        activeVersion: {
          payload: {
            brand_voice: {
              mode: "cloned",
              provider_voice_id: "voice-abc",
              provider: "elevenlabs",
              preset_voice: "alloy",
              delivery_style: "",
              sample_asset_path: "/samples/s.mp3",
              cloned_label: "My Voice",
              cloned_at: "2025-01-01T00:00:00Z",
            },
          },
        },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
    }),
    useGetBrandVoiceStatus: () => ({
      data: { enabled: true, configured: true },
    }),
    useWalletGetOverview: () => ({
      data: mockState.walletOverview,
      isLoading: false,
    }),
  });
});

// ── Import the component under test (after all vi.mock calls) ─────────────────
import BrandVoiceScreen from "../app/brand-voice";

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderScreen() {
  return render(<BrandVoiceScreen />);
}

function getScriptInput() {
  // react-native-web renders a multiline TextInput as a <textarea>
  const el =
    document.querySelector("[data-testid='input-audio-script']") ??
    document.querySelector("textarea[data-testid='input-audio-script']");
  if (!el) throw new Error("input-audio-script not found");
  return el as HTMLElement;
}

function typeScript(text: string) {
  fireEvent.change(getScriptInput(), { target: { value: text } });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("audio cost estimate on Brand Voice screen", () => {
  beforeEach(() => {
    // Reset to the wallet-enabled, rate-configured, sufficient-balance baseline.
    mockState.walletBilling = true;
    mockState.walletOverview = {
      walletBilling: true,
      balancePaise: 1000,
      rates: { captionPaise: 500 },
    };
  });

  it("renders the estimate when walletBilling=true, captionPaise>0, and script is non-empty", () => {
    renderScreen();
    typeScript("Hello, this is my script.");
    expect(screen.getByTestId("text-audio-wallet-estimate")).toBeTruthy();
  });

  it("hides the estimate when the script is empty", () => {
    renderScreen();
    // No script typed — estimate must not be present.
    expect(screen.queryByTestId("text-audio-wallet-estimate")).toBeNull();
  });

  it("hides the estimate after the script is cleared", () => {
    renderScreen();
    typeScript("Some text");
    expect(screen.getByTestId("text-audio-wallet-estimate")).toBeTruthy();
    typeScript("");
    expect(screen.queryByTestId("text-audio-wallet-estimate")).toBeNull();
  });

  it("hides the estimate when walletBilling=false (non-wallet tenant)", () => {
    mockState.walletBilling = false;
    renderScreen();
    typeScript("Hello, this is my script.");
    expect(screen.queryByTestId("text-audio-wallet-estimate")).toBeNull();
  });

  it("hides the estimate when captionPaise=0 (rate not configured)", () => {
    mockState.walletOverview = {
      walletBilling: true,
      balancePaise: 1000,
      rates: { captionPaise: 0 },
    };
    renderScreen();
    typeScript("Hello, this is my script.");
    expect(screen.queryByTestId("text-audio-wallet-estimate")).toBeNull();
  });

  it("shows the shortfall warning when balance < captionPaise", () => {
    mockState.walletOverview = {
      walletBilling: true,
      balancePaise: 100, // less than captionPaise (500)
      rates: { captionPaise: 500 },
    };
    renderScreen();
    typeScript("Hello, this is my script.");
    expect(screen.getByTestId("text-audio-wallet-estimate")).toBeTruthy();
    expect(screen.getByTestId("text-audio-wallet-estimate-shortfall")).toBeTruthy();
    expect(
      screen.getByTestId("text-audio-wallet-estimate-shortfall").textContent,
    ).toMatch(/recharge before generating/i);
  });

  it("hides the shortfall warning when balance >= captionPaise", () => {
    // walletOverview already has balancePaise=1000 > captionPaise=500.
    renderScreen();
    typeScript("Hello, this is my script.");
    expect(screen.getByTestId("text-audio-wallet-estimate")).toBeTruthy();
    expect(screen.queryByTestId("text-audio-wallet-estimate-shortfall")).toBeNull();
  });
});
