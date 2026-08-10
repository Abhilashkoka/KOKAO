/**
 * Interview onboarding: answering the four questions must create a Brand Kit
 * from the answers, generate a first draft post in the user's voice, save it
 * to the Library, and emit the analytics events the activation funnel reads.
 * Skipping and post-generation failure (e.g. no funding) must degrade
 * gracefully — onboarding always completes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/analytics", () => ({
  initAnalytics: vi.fn(),
  setConsentState: vi.fn(),
  trackPageView: vi.fn(),
  trackSignUpOnce: vi.fn(),
  track: vi.fn(),
}));

const mockState: {
  draftCalls: any[];
  draftError: unknown;
  createBrandKitCalls: any[];
  captionCalls: any[];
  captionError: unknown;
  captionResult: any;
  contentCalls: any[];
  completeCalls: any[];
} = {
  draftCalls: [],
  draftError: null,
  createBrandKitCalls: [],
  captionCalls: [],
  captionError: null,
  captionResult: null,
  contentCalls: [],
  completeCalls: [],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: { tenantId: "t1", brandOnboardingComplete: false },
    }),
    useGetConsent: () => ({ data: { responded: true } }),
    useDraftBrandKit: () => ({
      mutateAsync: async (vars: any) => {
        mockState.draftCalls.push(vars);
        if (mockState.draftError) throw mockState.draftError;
        return { payload: { identity: { brand_name: "Acme Coffee" } } };
      },
    }),
    useCreateBrandKit: () => ({
      mutateAsync: async (vars: any) => {
        mockState.createBrandKitCalls.push(vars);
        return { id: 42, name: vars.data.name };
      },
    }),
    useGenerateCaption: () => ({
      mutateAsync: async (vars: any) => {
        mockState.captionCalls.push(vars);
        if (mockState.captionError) throw mockState.captionError;
        return mockState.captionResult;
      },
    }),
    useCreateContent: () => ({
      mutateAsync: async (vars: any) => {
        mockState.contentCalls.push(vars);
        return { id: 7, ...vars.data };
      },
    }),
    useCompleteOnboarding: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.completeCalls.push(vars);
        opts?.onSuccess?.({ ok: true });
      },
    }),
  });
});

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({ flags: { aiStudio: true } }),
}));

const setLocation = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/", setLocation],
}));

import { track } from "@/lib/analytics";
import { OnboardingWizard } from "./onboarding-wizard";

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OnboardingWizard />
    </QueryClientProvider>,
  );
}

async function answerInterview() {
  // Welcome -> interview.
  fireEvent.click(await screen.findByRole("button", { name: /let's do it/i }));

  fireEvent.change(screen.getByPlaceholderText(/acme coffee/i), {
    target: { value: "Acme Coffee" },
  });
  fireEvent.click(screen.getByRole("button", { name: /next/i }));

  fireEvent.change(screen.getByPlaceholderText(/small-batch coffee/i), {
    target: { value: "We roast small-batch coffee." },
  });
  fireEvent.click(screen.getByRole("button", { name: /next/i }));

  fireEvent.change(screen.getByPlaceholderText(/young professionals/i), {
    target: { value: "City coffee lovers" },
  });
  fireEvent.click(screen.getByRole("button", { name: /next/i }));

  // Tone via chip.
  fireEvent.click(screen.getByRole("button", { name: "Playful" }));
  fireEvent.click(
    screen.getByRole("button", { name: /create my brand & first post/i }),
  );
}

beforeEach(() => {
  cleanup();
  vi.mocked(track).mockClear();
  setLocation.mockClear();
  mockState.draftCalls = [];
  mockState.draftError = null;
  mockState.createBrandKitCalls = [];
  mockState.captionCalls = [];
  mockState.captionError = null;
  mockState.captionResult = {
    caption: "Hello from Acme Coffee!",
    hashtags: ["#coffee", "#acme"],
    title: "Meet Acme Coffee",
  };
  mockState.contentCalls = [];
  mockState.completeCalls = [];
});

describe("interview onboarding", () => {
  it("answers flow into the Brand Kit draft and a saved first draft post", async () => {
    mount();
    await answerInterview();

    await waitFor(() => expect(mockState.completeCalls.length).toBe(1));

    // Brand Kit drafted from the interview answers.
    expect(mockState.draftCalls[0].data.brandName).toBe("Acme Coffee");
    expect(mockState.draftCalls[0].data.notes).toContain(
      "We roast small-batch coffee.",
    );
    expect(mockState.draftCalls[0].data.notes).toContain("City coffee lovers");
    expect(mockState.draftCalls[0].data.notes).toContain("Playful");
    expect(mockState.createBrandKitCalls[0].data).toMatchObject({
      name: "Acme Coffee",
      brandType: "primary",
      isDefault: true,
    });

    // First post generated with the brand kit + tone, saved as a draft.
    expect(mockState.captionCalls[0].data).toMatchObject({
      brandKitId: 42,
      tone: "Playful",
      platform: "instagram",
    });
    expect(mockState.contentCalls[0].data).toMatchObject({
      title: "Meet Acme Coffee",
      status: "draft",
      brandKitId: 42,
      platform: "instagram",
    });
    expect(mockState.contentCalls[0].data.caption).toContain("#coffee");

    // Completed (not skipped), user lands in the Library on their draft.
    expect(mockState.completeCalls[0].data.skipped).toBe(false);
    expect(setLocation).toHaveBeenCalledWith("/library");

    // Funnel events.
    const events = vi.mocked(track).mock.calls.map((c) => c[0]);
    expect(events).toContain("onboarding_started");
    expect(events).toContain("onboarding_interview_completed");
    expect(events).toContain("caption_generated");
    expect(events).toContain("content_saved");
    expect(events).toContain("onboarding_first_post_generated");
    expect(events).toContain("onboarding_completed");
  });

  it("still completes with the brand kit when post generation fails (no charge path)", async () => {
    mockState.captionError = { status: 402 };
    mount();
    await answerInterview();

    await waitFor(() => expect(mockState.completeCalls.length).toBe(1));
    expect(mockState.createBrandKitCalls.length).toBe(1);
    expect(mockState.contentCalls.length).toBe(0);
    expect(mockState.completeCalls[0].data.skipped).toBe(false);
    expect(setLocation).toHaveBeenCalledWith("/studio");
    const events = vi.mocked(track).mock.calls.map((c) => c[0]);
    expect(events).toContain("onboarding_first_post_failed");
  });

  it("falls back to a blank kit when the AI draft fails, and still writes the post", async () => {
    mockState.draftError = new Error("draft down");
    mount();
    await answerInterview();

    await waitFor(() => expect(mockState.completeCalls.length).toBe(1));
    expect(mockState.createBrandKitCalls[0].data.payload).toBeNull();
    expect(mockState.contentCalls.length).toBe(1);
  });

  it("skipping from the interview completes onboarding as skipped and emits the skip event", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /let's do it/i }));
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));

    await waitFor(() => expect(mockState.completeCalls.length).toBe(1));
    expect(mockState.completeCalls[0].data.skipped).toBe(true);
    expect(mockState.createBrandKitCalls.length).toBe(0);
    const events = vi.mocked(track).mock.calls.map((c) => c[0]);
    expect(events).toContain("onboarding_skipped");
    expect(events).not.toContain("onboarding_completed");
  });
});
