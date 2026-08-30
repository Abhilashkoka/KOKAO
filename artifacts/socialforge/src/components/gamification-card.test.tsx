import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockState: {
  gamification: any;
  me: any;
  lastClaimVars: any;
} = {
  gamification: undefined,
  me: undefined,
  lastClaimVars: null,
};

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter/use-browser-location", () => ({
  navigate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetGamification: () => ({ data: mockState.gamification }),
    useGetMe: () => ({ data: mockState.me }),
    useClaimGamificationReward: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastClaimVars = vars;
        opts?.onSuccess?.({
          ok: true,
          granted: { captionCredits: 2, imageCredits: 0, videoCredits: 0 },
          credits: { captionCredits: 2, imageCredits: 0, videoCredits: 0 },
        });
      },
    }),
  });
});

import { GamificationCard } from "./gamification-card";

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <GamificationCard />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const baseState = () => ({
  questsEnabled: true,
  streaksEnabled: true,
  referralsEnabled: true,
  progressMeterEnabled: true,
  quests: [
    {
      id: "create_brand_kit",
      title: "Create a brand kit",
      description: "Teach KOKAO your style.",
      completed: true,
      claimed: false,
      claimKey: "quest:create_brand_kit",
      reward: { captionCredits: 2, imageCredits: 0, videoCredits: 0 },
    },
    {
      id: "first_image",
      title: "Generate your first image",
      description: "Create a visual.",
      completed: false,
      claimed: false,
      claimKey: "quest:first_image",
      reward: { captionCredits: 0, imageCredits: 2, videoCredits: 0 },
    },
  ],
  streak: {
    currentDays: 3,
    activeToday: true,
    milestones: [
      {
        days: 3,
        reward: { captionCredits: 1, imageCredits: 1, videoCredits: 0 },
        reached: true,
        claimed: false,
        claimKey: "streak:3:2026-07-20",
      },
      {
        days: 7,
        reward: { captionCredits: 2, imageCredits: 2, videoCredits: 0 },
        reached: false,
        claimed: false,
        claimKey: "streak:7:2026-07-20",
      },
    ],
  },
});

beforeEach(() => {
  mockState.gamification = baseState();
  mockState.me = {
    usage: { captions: 8, images: 4, videos: 1 },
    limits: { captions: 10, images: 5, videos: 3 },
  };
  mockState.lastClaimVars = null;
  toastSpy.mockClear();
  cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GamificationCard", () => {
  it("renders nothing when every mechanic is disabled", () => {
    mockState.gamification = {
      ...baseState(),
      questsEnabled: false,
      streaksEnabled: false,
      referralsEnabled: false,
      progressMeterEnabled: false,
    };
    const { container } = renderCard();
    expect(container.innerHTML).toBe("");
  });

  it("shows the streak, claimable count, and claims a completed quest", async () => {
    renderCard();
    expect(screen.getByTestId("streak-days").textContent).toContain("3-day streak");
    // 1 claimable quest + 1 reached streak milestone.
    expect(screen.getByTestId("claimable-count").textContent).toContain("2 rewards");

    fireEvent.click(screen.getByTestId("claim-quest-create_brand_kit"));
    await waitFor(() => expect(mockState.lastClaimVars).toBeTruthy());
    expect(mockState.lastClaimVars.data.key).toBe("quest:create_brand_kit");
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reward claimed!" }),
    );

    // The incomplete quest shows no claim button.
    expect(screen.queryByTestId("claim-quest-first_image")).toBeNull();
  });

  it("automatically minimizes 1.5 seconds after it appears", () => {
    vi.useFakeTimers();
    renderCard();

    expect(screen.getByTestId("quest-create_brand_kit")).toBeTruthy();
    expect(screen.getByTestId("button-toggle-gamification").textContent).toContain("Hide");

    act(() => {
      vi.advanceTimersByTime(1_499);
    });
    expect(screen.getByTestId("quest-create_brand_kit")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId("quest-create_brand_kit")).toBeNull();
    expect(screen.getByTestId("button-toggle-gamification").textContent).toContain("Details");
  });

  it("claims a reached streak milestone", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("claim-streak-3"));
    await waitFor(() => expect(mockState.lastClaimVars).toBeTruthy());
    expect(mockState.lastClaimVars.data.key).toBe("streak:3:2026-07-20");
  });

  it("shows the upgrade meter only for finite limits", () => {
    renderCard();
    expect(screen.getByTestId("button-upgrade-meter")).toBeTruthy();

    cleanup();
    // Unlimited plan: no finite rows, meter hidden.
    mockState.me = {
      usage: { captions: 50, images: 20, videos: 5 },
      limits: { captions: -1, images: -1, videos: -1 },
    };
    renderCard();
    expect(screen.queryByTestId("button-upgrade-meter")).toBeNull();
  });
});
