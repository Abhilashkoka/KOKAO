/**
 * Mobile Videos screen — 402 handling for video generation (app/videos.tsx):
 * - wallet-billed owners see the "Wallet balance too low" title with the
 *   server's wallet-flavored shortfall message verbatim
 * - wallet-billed members are told to ask the owner to recharge
 * - quota-billed workspaces keep the "Video quota reached" framing
 * - non-402 errors keep the plain notice banner (no quota notice)
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const WALLET_SHORTFALL =
  "This video needs 4 generations and your wallet balance can't cover it. Recharge to continue.";

const mockState: {
  wallet: { walletBilling: boolean } | undefined;
  me: Record<string, unknown> | undefined;
  generateError: unknown;
  jobs: Array<Record<string, unknown>>;
} = { wallet: undefined, me: undefined, generateError: null, jobs: [] };

const generateMutate = vi.fn(
  (_vars: unknown, opts?: { onError?: (err: unknown) => void; onSuccess?: () => void }) => {
    if (mockState.generateError) opts?.onError?.(mockState.generateError);
    else opts?.onSuccess?.();
  },
);

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListVideoJobs: () => ({
      data: mockState.jobs,
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useListFeatureFlags: () => ({ data: undefined, isLoading: false }),
    useGetAiSpendRates: () => ({ data: undefined, isLoading: false }),
    useGenerateVideo: () => ({ mutate: generateMutate, isPending: false }),
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
    useGetMe: () => ({ data: mockState.me, isLoading: false }),
  });
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));
vi.mock("expo-video", () => ({ useVideoPlayer: () => ({}), VideoView: () => null }));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("@/components/ContentImage", () => ({ ContentImage: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// QuotaInfoSheet uses react-native-safe-area-context (already mocked above).
// Inline the pure utility logic and constants so the 402 test can verify
// the real framing logic without loading the native sheet component.
// vi.mock is hoisted, so any values it closes over must be declared with
// vi.hoisted so they exist at hoist time.
// vi.mock is hoisted, so closures inside must use vi.hoisted values.
// Use _impl_ prefix to avoid clashing with the named import below.
const _quotaConsts = vi.hoisted(() => ({
  fallback: "You have reached your monthly AI quota. Upgrade your plan on the web app to continue.",
  ownerWallet: "You've reached your monthly AI limit. Recharge your prepaid wallet on the web app to keep generating.",
  memberAskOwner: "The workspace has run out of AI quota. Ask your workspace owner to upgrade.",
  memberWallet: "The workspace has run out of AI quota. Ask your workspace owner to recharge the prepaid wallet.",
  memberPlain: "The workspace is out of AI quota.",
}));

vi.mock("@/components/QuotaInfoSheet", () => ({
  isQuotaError: (err: unknown) => (err as { status?: number } | null)?.status === 402,
  quotaErrorTitle: (walletBilling: boolean, quotaTitle = "AI quota reached") =>
    walletBilling ? "Wallet balance too low" : quotaTitle,
  quotaErrorMessage: (err: unknown, opts?: { isOwner?: boolean; upgradeRequestsEnabled?: boolean; walletBilling?: boolean }) => {
    if (opts?.isOwner === false) {
      if (opts.walletBilling) return _quotaConsts.memberWallet;
      return opts.upgradeRequestsEnabled ? _quotaConsts.memberAskOwner : _quotaConsts.memberPlain;
    }
    const data = (err as { data?: { error?: string } | null } | null)?.data;
    const msg = typeof data?.error === "string" && data.error.trim() ? data.error.trim() : null;
    if (opts?.walletBilling) {
      if (msg && /wallet|recharge/i.test(msg)) return msg;
      return _quotaConsts.ownerWallet;
    }
    return msg || _quotaConsts.fallback;
  },
  QUOTA_FALLBACK_MESSAGE: _quotaConsts.fallback,
  QUOTA_OWNER_WALLET_MESSAGE: _quotaConsts.ownerWallet,
  QUOTA_MEMBER_ASK_OWNER_MESSAGE: _quotaConsts.memberAskOwner,
  QUOTA_MEMBER_WALLET_MESSAGE: _quotaConsts.memberWallet,
  QUOTA_MEMBER_PLAIN_MESSAGE: _quotaConsts.memberPlain,
  useWalletBilling: () => mockState.wallet?.walletBilling === true,
  QuotaErrorNotice: ({ title, message }: { title?: string; message: string; onPress?: () => void }) =>
    React.createElement(React.Fragment, null,
      title ? React.createElement("span", { "data-testid": "quota-notice-title" }, title) : null,
      React.createElement("span", { "data-testid": "quota-notice-message" }, message),
    ),
  QuotaInfoSheet: () => null,
}));
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: () => null,
}));
vi.mock("react-native-webview", () => ({ WebView: () => null }));

import VideosScreen from "../app/videos";
import {
  QUOTA_MEMBER_WALLET_MESSAGE,
  QUOTA_MEMBER_ASK_OWNER_MESSAGE,
} from "@/components/QuotaInfoSheet";

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideosScreen />
    </QueryClientProvider>,
  );
}

function generate() {
  fireEvent.change(screen.getByTestId("input-video-brief"), {
    target: { value: "A cozy cafe montage" },
  });
  fireEvent.click(screen.getByTestId("button-generate-video"));
}

describe("Videos screen — 402 handling", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockState.wallet = undefined;
    mockState.me = undefined;
    mockState.generateError = null;
    mockState.jobs = [];
  });

  it("wallet-billed owner sees the wallet title and the server's shortfall message verbatim", () => {
    mockState.wallet = { walletBilling: true };
    mockState.generateError = { status: 402, data: { error: WALLET_SHORTFALL } };
    renderScreen();
    generate();
    expect(screen.getByText("Wallet balance too low")).toBeTruthy();
    expect(screen.getByText(WALLET_SHORTFALL)).toBeTruthy();
    expect(screen.queryByText(/Video quota reached/)).toBeNull();
  });

  it("wallet-billed member is told to ask the owner to recharge", () => {
    mockState.wallet = { walletBilling: true };
    mockState.me = { team: { role: "member" } };
    mockState.generateError = { status: 402, data: { error: WALLET_SHORTFALL } };
    renderScreen();
    generate();
    expect(screen.getByText("Wallet balance too low")).toBeTruthy();
    expect(screen.getByText(QUOTA_MEMBER_WALLET_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(WALLET_SHORTFALL)).toBeNull();
  });

  it("a 402 landing before the wallet overview resolves upgrades to wallet copy once it does", () => {
    // Wallet overview hasn't resolved yet → walletBilling reads false.
    mockState.wallet = undefined;
    mockState.generateError = { status: 402, data: { error: WALLET_SHORTFALL } };
    const view = renderScreen();
    generate();
    // The shortfall message matches /wallet|recharge/i, so it's shown either
    // way — but the title is still quota-framed pre-resolution.
    expect(screen.getByText("Video quota reached")).toBeTruthy();

    // Wallet overview resolves: derived copy flips to wallet framing.
    mockState.wallet = { walletBilling: true };
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <VideosScreen />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Wallet balance too low")).toBeTruthy();
    expect(screen.getByText(WALLET_SHORTFALL)).toBeTruthy();
  });

  it("quota-billed workspace keeps the quota framing and server message", () => {
    mockState.generateError = {
      status: 402,
      data: { error: "Monthly video quota reached. Upgrade your plan." },
    };
    renderScreen();
    generate();
    expect(screen.getByText("Video quota reached")).toBeTruthy();
    expect(screen.getByText("Monthly video quota reached. Upgrade your plan.")).toBeTruthy();
    expect(screen.queryByText("Wallet balance too low")).toBeNull();
  });

  it("quota-billed member is told to ask the owner to upgrade", () => {
    mockState.me = { team: { role: "member" } };
    mockState.generateError = { status: 402, data: { error: "Quota reached." } };
    renderScreen();
    generate();
    expect(screen.getByText(QUOTA_MEMBER_ASK_OWNER_MESSAGE)).toBeTruthy();
  });

  it("non-402 errors keep the plain notice banner", () => {
    // The notice banner renders as the job list header, so seed one job.
    mockState.jobs = [
      {
        id: 1,
        engine: "text_to_video",
        prompt: "A launch teaser",
        status: "queued",
        stage: null,
        error: null,
        units: 1,
        videoPath: null,
        thumbnailPath: null,
        aspectRatio: "9:16",
        createdAt: new Date("2026-08-01T00:00:00Z").toISOString(),
        storyboard: null,
      },
    ];
    mockState.generateError = { status: 500, data: { error: "Video engine unavailable." } };
    renderScreen();
    generate();
    expect(screen.getByTestId("banner-video-cancel-notice").textContent).toContain(
      "Video engine unavailable.",
    );
    expect(screen.queryByText("Wallet balance too low")).toBeNull();
    expect(screen.queryByText("Video quota reached")).toBeNull();
  });
});
