/**
 * Regression guard: when an AI generation hits the monthly quota (402) in the
 * mobile Studio, non-owner team members get an inline "Ask the owner for an
 * upgrade" button (reusing POST /billing/request-upgrade). Owners never see
 * it, and it is hidden when the upgradeRequests kill switch is off.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const requestUpgradeMutate = vi.fn();

const mockState: {
  team: { role: string; workspaceName: string } | null;
  flags: Record<string, boolean> | undefined;
} = {
  team: null,
  flags: undefined,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { id: 1, name: "Test Workspace", plan: "free" },
        usage: { captions: 1, images: 1 },
        limits: { captions: 10, images: 10 },
        credits: { captionCredits: 0, imageCredits: 0 },
        team: mockState.team,
      },
      isLoading: false,
    }),
    useListFeatureFlags: () => ({ data: mockState.flags, isLoading: false }),
    useGenerateCaption: () => ({
      ...idleMutation(),
      mutate: (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({
          status: 402,
          data: { error: "Monthly caption quota exceeded" },
        });
      },
    }),
    useBillingRequestUpgrade: () => ({
      ...idleMutation(),
      mutate: requestUpgradeMutate,
    }),
    useListBrandKits: () => ({ data: [], isLoading: false }),
  });
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("expo-image", () => ({
  Image: () => null,
}));
vi.mock("@/components/KeyboardAwareScrollViewCompat", async () => {
  const { ScrollView } = await import("react-native");
  return {
    KeyboardAwareScrollViewCompat: ({ children, ...props }: any) => (
      <ScrollView {...props}>{children}</ScrollView>
    ),
  };
});
vi.mock("@/components/VoiceNoteButton", () => ({
  VoiceNoteButton: () => null,
}));
vi.mock("@/components/ContentImage", () => ({
  ContentImage: () => null,
}));
vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
  trackFeatureUse: vi.fn(),
}));

import StudioScreen from "../app/(tabs)/studio";

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StudioScreen />
    </QueryClientProvider>,
  );
}

async function hitQuotaWall(expectedText: RegExp = /Monthly caption quota exceeded/i) {
  renderScreen();
  fireEvent.change(
    screen.getByPlaceholderText("e.g. Announcing our new summer collection"),
    { target: { value: "A prompt for a caption" } },
  );
  fireEvent.click(screen.getByText("Generate caption"));
  await waitFor(() => expect(screen.getByText(expectedText)).toBeTruthy());
}

beforeEach(() => {
  cleanup();
  requestUpgradeMutate.mockReset();
  mockState.team = null;
  mockState.flags = undefined;
});

describe("Studio quota-wall upgrade-request nudge (mobile)", () => {
  it("offers 'Ask the owner for an upgrade' to a non-owner member and fires the request", async () => {
    mockState.team = { role: "member", workspaceName: "Acme" };
    // Members see role-appropriate copy, not the server's owner-directed text.
    await hitQuotaWall(/Ask your workspace owner to upgrade/i);
    expect(screen.queryByText(/Monthly caption quota exceeded/i)).toBeNull();
    const button = screen.getByText("Ask the owner for an upgrade");
    fireEvent.click(button);
    expect(requestUpgradeMutate).toHaveBeenCalledTimes(1);
    // Simulate the success callback to show the confirmation notice.
    const opts = requestUpgradeMutate.mock.calls[0][1] as {
      onSuccess?: () => void;
    };
    opts.onSuccess?.();
    await waitFor(() => expect(screen.getByText(/Request sent/i)).toBeTruthy());
  });

  it("does not offer the request button to the workspace owner", async () => {
    mockState.team = { role: "owner", workspaceName: "Acme" };
    await hitQuotaWall();
    expect(screen.queryByText("Ask the owner for an upgrade")).toBeNull();
  });

  it("does not offer the request button when there is no team context", async () => {
    await hitQuotaWall();
    expect(screen.queryByText("Ask the owner for an upgrade")).toBeNull();
  });

  it("hides the request button when the upgradeRequests switch is off", async () => {
    mockState.team = { role: "member", workspaceName: "Acme" };
    mockState.flags = { upgradeRequests: false };
    // With upgrade requests off, members get a plain out-of-quota notice.
    await hitQuotaWall(/The workspace is out of AI quota/i);
    expect(screen.queryByText("Ask the owner for an upgrade")).toBeNull();
  });
});
