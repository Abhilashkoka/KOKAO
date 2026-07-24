import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate } from "wouter/use-browser-location";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  splitIntoTweets,
  THREADS_MAX_LENGTH,
  chunkOnWhitespace,
  LINKEDIN_MAX_LENGTH,
  isOverLinkedinLimit,
  splitForLinkedin,
} from "@workspace/social-limits";

/**
 * Guard: the Studio caption result's X character warning must be derived from
 * the shared @workspace/social-limits helpers so the on-screen warning always
 * matches what the server does on publish. Expected values are computed FROM
 * the shared helpers — a local re-implementation of the 280 count would drift
 * and fail these tests.
 */

// Radix selects need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const defaultMe = () => ({
  tenant: { id: 1 },
  usage: { captions: 2, images: 1 },
  limits: { captions: 10, images: 5 },
});

const mockState: {
  caption: string;
  lastCaptionVars: any;
  lastImageVars: any;
  lastCampaignVars: any;
  me: any;
  campaignError: any;
  aiSpendRates: any;
  featureFlags: any;
  connections: {
    facebook: any;
    instagram: any;
    linkedin: any;
    twitter: any;
  };
} = {
  caption: "",
  lastCaptionVars: null,
  lastImageVars: null,
  lastCampaignVars: null,
  me: defaultMe(),
  campaignError: null,
  aiSpendRates: undefined,
  featureFlags: undefined,
  connections: defaultConnections(),
};

function defaultConnections() {
  return {
    facebook: { appConfigured: true, saved: true, verifyStatus: "verified" },
    instagram: { appConfigured: true, saved: true, verifyStatus: "verified" },
    linkedin: { configured: true, connected: true, expired: false },
    twitter: { configured: true, connected: true, expired: false },
  };
}

const toastSpy = vi.fn();
const requestUpgradeSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter/use-browser-location", () => ({
  navigate: vi.fn(),
}));

// The SSE caption stream needs a real streaming fetch, which jsdom lacks.
// Rejecting with a 404 drives studio through its JSON fallback path, which
// is what these tests assert against.
vi.mock("@/lib/captionStream", () => ({
  streamCaptionRequest: () =>
    Promise.reject(Object.assign(new Error("stream unavailable in tests"), { status: 404 })),
}));

// Resilient mock: unknown hooks fall back to an idle stub, so adding a new
// hook to studio.tsx does not break these tests.
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGenerateCaption: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastCaptionVars = vars;
        opts?.onSuccess?.({ caption: mockState.caption, hashtags: [] });
      },
    }),
    useGenerateImage: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastImageVars = vars;
        opts?.onSuccess?.({ imagePath: "/objects/t1/uploads/x", b64Json: "aW1n" });
      },
    }),
    useGenerateCampaign: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.lastCampaignVars = vars;
        if (mockState.campaignError) {
          opts?.onError?.(mockState.campaignError);
          return;
        }
        opts?.onSuccess?.({
          posts: (vars?.data?.platforms ?? []).map((platform: string) => ({
            platform,
            caption: `Caption for ${platform}`,
            hashtags: [],
            imagePrompt: `Image for ${platform}`,
          })),
        });
      },
    }),
    useGetMe: () => ({ data: mockState.me }),
    useBillingRequestUpgrade: () => ({
      isPending: false,
      mutate: requestUpgradeSpy,
    }),
    useGetAiSpendRates: () => ({ data: mockState.aiSpendRates, isLoading: false }),
    useListFeatureFlags: () => ({ data: mockState.featureFlags, isLoading: false }),
    useListBrandKits: () => ({ data: [] }),
    useGetFacebookCredentials: () => ({ data: mockState.connections.facebook, isLoading: false }),
    useGetInstagramCredentials: () => ({ data: mockState.connections.instagram, isLoading: false }),
    useGetLinkedinStatus: () => ({ data: mockState.connections.linkedin, isLoading: false }),
    useGetTwitterStatus: () => ({ data: mockState.connections.twitter, isLoading: false }),
    // Async image jobs report "route disabled" so studio falls back to the
    // sync useGenerateImage path these tests drive.
    generateImageAsync: async () => {
      throw Object.assign(new Error("async jobs unavailable in tests"), { status: 404 });
    },
  });
});

import { StudioPage } from "./studio";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <StudioPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function generateCaption(caption: string, platform: "twitter" | "instagram" = "twitter") {
  mockState.caption = caption;
  renderPage();
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "A prompt long enough to pass validation" },
  });
  if (platform === "twitter") {
    // Platform now derives from the Campaign platforms selection (first pick
    // wins), so leave only Twitter toggled on.
    const user = userEvent.setup();
    await user.click(screen.getByTestId("toggle-campaign-instagram"));
    await user.click(screen.getByTestId("toggle-campaign-facebook"));
    await user.click(screen.getByTestId("toggle-campaign-linkedin"));
  }
  fireEvent.click(screen.getByTestId("button-generate-caption"));
  // react-hook-form submit resolution is async.
  await waitFor(() => expect(screen.getByText(caption)).toBeTruthy());
}

beforeEach(() => {
  mockState.lastCaptionVars = null;
  mockState.lastImageVars = null;
  mockState.lastCampaignVars = null;
  mockState.me = defaultMe();
  mockState.campaignError = null;
  mockState.aiSpendRates = undefined;
  mockState.featureFlags = undefined;
  mockState.connections = defaultConnections();
  toastSpy.mockClear();
  requestUpgradeSpy.mockClear();
  localStorage.clear();
  cleanup();
});

async function generateImage() {
  renderPage();
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "A prompt long enough to pass validation" },
  });
  fireEvent.click(screen.getByTestId("button-generate-image"));
  await waitFor(() => expect(mockState.lastImageVars).toBeTruthy());
}

describe("Studio caption X character warning", () => {
  it("shows count without warning for an under-limit caption", async () => {
    const caption = "A perfectly fine short caption.";
    expect(isOverTweetLimit(caption)).toBe(false);
    await generateCaption(caption);
    expect(
      screen.getByText(`${caption.length} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("shows no warning at exactly the limit", async () => {
    const caption = "b".repeat(TWEET_MAX_LENGTH);
    expect(tweetOverBy(caption)).toBe(0);
    await generateCaption(caption);
    expect(
      screen.getByText(`${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("warns with the shared helper's over-by count when over the limit", async () => {
    const caption = "b".repeat(TWEET_MAX_LENGTH + 37);
    expect(isOverTweetLimit(caption)).toBe(true);
    await generateCaption(caption);
    const warning = screen.getByText(
      `${caption.length} / ${TWEET_MAX_LENGTH} characters for X`,
      { exact: false },
    );
    expect(warning.textContent).toContain(`${tweetOverBy(caption)} over`);
    expect(warning.textContent).toContain(
      `will post as a thread of ${splitIntoTweets(caption).length} tweets on X`,
    );
    expect(warning.textContent).not.toContain("trimmed");
  });

  it("shows no X warning when the caption was generated for another platform", async () => {
    const caption = "e".repeat(TWEET_MAX_LENGTH + 10);
    expect(isOverTweetLimit(caption)).toBe(true);
    await generateCaption(caption, "instagram");
    expect(screen.queryByText(/characters for X/i)).toBeNull();
  });
});

describe("Studio caption Threads character warning", () => {
  it("shows count without warning for an under-limit caption", async () => {
    const caption = "A perfectly fine short caption for Threads.";
    await generateCaption(caption);
    expect(
      screen.getByText(`${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a chain/i)).toBeNull();
  });

  it("warns with the shared helper's chunk count when over the Threads limit", async () => {
    const caption = "t".repeat(THREADS_MAX_LENGTH + 60);
    const chunks = chunkOnWhitespace(caption, THREADS_MAX_LENGTH);
    expect(chunks.length).toBeGreaterThan(1);
    await generateCaption(caption);
    const warning = screen.getByText(
      `${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `will post as a chain of ${chunks.length} connected posts on Threads`,
    );
  });
});

describe("Studio caption LinkedIn character warning", () => {
  it("shows count without warning for an under-limit caption", async () => {
    const caption = "A perfectly fine short caption for LinkedIn.";
    expect(isOverLinkedinLimit(caption)).toBe(false);
    await generateCaption(caption);
    expect(
      screen.getByText(`${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/follow-up comment/i)).toBeNull();
  });

  it("warns with the shared helper's comment count when over the LinkedIn limit", async () => {
    const caption = "l".repeat(LINKEDIN_MAX_LENGTH + 200);
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const commentCount = splitForLinkedin(caption).comments.length;
    await generateCaption(caption);
    const warning = screen.getByText(
      `${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"} on LinkedIn`,
    );
  });
});

describe("Studio caption regenerate and tweak chips", () => {
  it("shows tweak chips and a Regenerate button after a caption is generated", async () => {
    await generateCaption("A caption to tweak.", "instagram");
    expect(screen.getByTestId("button-tweak-shorter")).toBeTruthy();
    expect(screen.getByTestId("button-tweak-punchier")).toBeTruthy();
    expect(screen.getByTestId("button-tweak-more-formal")).toBeTruthy();
    expect(screen.getByTestId("button-regenerate-caption")).toBeTruthy();
  });

  it("appends the tweak instruction to the prompt when a chip is clicked", async () => {
    await generateCaption("A caption to tweak.", "instagram");
    const basePrompt = mockState.lastCaptionVars.data.prompt;
    fireEvent.click(screen.getByTestId("button-tweak-shorter"));
    await waitFor(() =>
      expect(mockState.lastCaptionVars.data.prompt).toBe(
        `${basePrompt} Make the caption shorter and more concise.`,
      ),
    );
  });

  it("regenerate resends the original prompt without any tweak instruction", async () => {
    await generateCaption("A caption to tweak.", "instagram");
    const basePrompt = mockState.lastCaptionVars.data.prompt;
    fireEvent.click(screen.getByTestId("button-tweak-punchier"));
    await waitFor(() =>
      expect(mockState.lastCaptionVars.data.prompt).toContain("punchier"),
    );
    fireEvent.click(screen.getByTestId("button-regenerate-caption"));
    await waitFor(() =>
      expect(mockState.lastCaptionVars.data.prompt).toBe(basePrompt),
    );
  });
});

describe("Studio image regenerate and style tweak chips", () => {
  it("shows style chips and a Regenerate button after an image is generated", async () => {
    await generateImage();
    expect(screen.getByTestId("button-image-tweak-brighter")).toBeTruthy();
    expect(screen.getByTestId("button-image-tweak-minimal")).toBeTruthy();
    expect(screen.getByTestId("button-image-tweak-more-vibrant")).toBeTruthy();
    expect(screen.getByTestId("button-regenerate-image")).toBeTruthy();
  });

  it("appends the tweak instruction to the prompt when a chip is clicked", async () => {
    await generateImage();
    const basePrompt = mockState.lastImageVars.data.prompt;
    fireEvent.click(screen.getByTestId("button-image-tweak-brighter"));
    await waitFor(() =>
      expect(mockState.lastImageVars.data.prompt).toBe(
        `${basePrompt} Make the image brighter with more light and airy tones.`,
      ),
    );
  });

  it("regenerate resends the original prompt without any tweak instruction", async () => {
    await generateImage();
    const basePrompt = mockState.lastImageVars.data.prompt;
    fireEvent.click(screen.getByTestId("button-image-tweak-minimal"));
    await waitFor(() =>
      expect(mockState.lastImageVars.data.prompt).toContain("minimal"),
    );
    fireEvent.click(screen.getByTestId("button-regenerate-image"));
    await waitFor(() =>
      expect(mockState.lastImageVars.data.prompt).toBe(basePrompt),
    );
  });
});

describe("Studio campaign generation quota-relevant variables", () => {
  it("submits the prompt and all default platforms", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(mockState.lastCampaignVars).toBeTruthy());
    expect(mockState.lastCampaignVars.data.prompt).toBe(
      "A campaign prompt long enough to pass validation",
    );
    expect(mockState.lastCampaignVars.data.platforms).toEqual([
      "instagram",
      "facebook",
      "linkedin",
      "twitter",
    ]);
  });

  it("submits only the platforms left selected after toggling some off", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Facebook" }));
    await user.click(screen.getByRole("button", { name: "Twitter / X" }));
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(mockState.lastCampaignVars).toBeTruthy());
    expect(mockState.lastCampaignVars.data.platforms).toEqual([
      "instagram",
      "linkedin",
    ]);
  });

  it("does not call the campaign mutation when no platforms are selected", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Instagram" }));
    await user.click(screen.getByRole("button", { name: "Facebook" }));
    await user.click(screen.getByRole("button", { name: "LinkedIn" }));
    await user.click(screen.getByRole("button", { name: "Twitter / X" }));
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    // The submit handler resolves asynchronously; flush it, then assert the
    // mutation was never invoked.
    await waitFor(() =>
      expect(screen.getByTestId("button-generate-campaign")).toBeTruthy(),
    );
    await Promise.resolve();
    expect(mockState.lastCampaignVars).toBeNull();
  });
});

describe("Studio campaign platform toggles gated by connection status", () => {
  it("keeps an unconnected platform out of the default selection and routes clicks to Accounts", async () => {
    mockState.connections.twitter = { configured: true, connected: false, expired: false };
    renderPage();
    const twitterToggle = screen.getByTestId("toggle-campaign-twitter");
    expect(twitterToggle).toHaveProperty("disabled", false);
    expect(twitterToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(twitterToggle);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith("/accounts");
    // Clicking never selects it.
    expect(twitterToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(mockState.lastCampaignVars).toBeTruthy());
    expect(mockState.lastCampaignVars.data.platforms).toEqual([
      "instagram",
      "facebook",
      "linkedin",
    ]);
  });

  it("keeps a platform without app-level credentials out of the campaign selection", async () => {
    mockState.connections.linkedin = { configured: false, connected: true, expired: false };
    renderPage();
    expect(screen.getByTestId("toggle-campaign-linkedin").getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(mockState.lastCampaignVars).toBeTruthy());
    expect(mockState.lastCampaignVars.data.platforms).toEqual([
      "instagram",
      "facebook",
      "twitter",
    ]);
  });

  it("deselects Instagram when Facebook is not verified, even if Instagram itself is verified", () => {
    mockState.connections.facebook = { appConfigured: true, saved: true, verifyStatus: "failed" };
    renderPage();
    expect(screen.getByTestId("toggle-campaign-instagram").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("toggle-campaign-facebook").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("toggle-campaign-linkedin").getAttribute("aria-pressed")).toBe("true");
  });

  it("deselects an expired connection and routes its click to Accounts", () => {
    mockState.connections.twitter = { configured: true, connected: true, expired: true };
    renderPage();
    const twitterToggle = screen.getByTestId("toggle-campaign-twitter");
    expect(twitterToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(twitterToggle);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith("/accounts");
  });

  it("shows the connect-accounts hint when nothing is connected", () => {
    mockState.connections = {
      facebook: { appConfigured: false, saved: false, verifyStatus: null },
      instagram: { appConfigured: false, saved: false, verifyStatus: null },
      linkedin: { configured: false, connected: false, expired: false },
      twitter: { configured: false, connected: false, expired: false },
    };
    renderPage();
    expect(screen.getByTestId("text-no-campaign-platforms")).toBeTruthy();
  });
});

describe("Studio image buttons when the monthly image quota is exhausted", () => {
  it("disables the Image button with a plan-limit hint when quota and credits are both zero", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderPage();
    const btn = screen.getByTestId("button-generate-image") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // The hint must be user-visible text (disabled buttons can't show tooltips).
    expect(screen.getByTestId("image-quota-hint").textContent).toMatch(
      /image limit reached/i,
    );
  });

  it("keeps the Image button enabled when quota is exhausted but image credits remain", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 3 },
    };
    renderPage();
    const btn = screen.getByTestId("button-generate-image") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId("image-quota-hint")).toBeNull();
  });

  it("keeps the Image button enabled on unlimited plans", () => {
    mockState.me = {
      usage: { captions: 2, images: 500 },
      limits: { captions: -1, images: -1 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderPage();
    const btn = screen.getByTestId("button-generate-image") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("keeps the caption button enabled when only the image quota is exhausted", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderPage();
    const btn = screen.getByTestId("button-generate-caption") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe("Studio campaign out-of-quota (402) error handling", () => {
  it("shows a clear quota-exceeded toast, not a generic error, on a 402", async () => {
    mockState.campaignError = {
      status: 402,
      message: "Monthly caption quota exceeded",
    };
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const toastArg = toastSpy.mock.calls[0][0];
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.description).toMatch(/quota exceeded|monthly/i);
    expect(toastArg.variant).toBe("destructive");
    expect(toastArg.title).not.toBe("Error");
  });

  it("recognizes a 402 nested under error.response.status", async () => {
    mockState.campaignError = { response: { status: 402 } };
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const toastArg = toastSpy.mock.calls[0][0];
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.description).toMatch(/monthly AI limit/i);
  });

  it("still uses the generic error toast for non-402 failures", async () => {
    mockState.campaignError = { status: 500, message: "Upstream exploded" };
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const toastArg = toastSpy.mock.calls[0][0];
    expect(toastArg.title).toBe("Error");
  });
});

describe("Studio 402 member upgrade-request nudge", () => {
  const trigger402 = async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    return toastSpy.mock.calls[0][0];
  };

  it("offers 'Ask the owner for an upgrade' to a non-owner member", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    mockState.me = { ...defaultMe(), team: { role: "member" } };
    const toastArg = await trigger402();
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.action).toBeTruthy();
    // Clicking the action fires the request-upgrade mutation.
    toastArg.action.props.onClick();
    expect(requestUpgradeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not offer the request action to the workspace owner", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    mockState.me = { ...defaultMe(), team: { role: "owner" } };
    const toastArg = await trigger402();
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.action).toBeUndefined();
  });

  it("does not offer the request action when the upgradeRequests switch is off", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    mockState.me = { ...defaultMe(), team: { role: "member" } };
    mockState.featureFlags = { upgradeRequests: false };
    const toastArg = await trigger402();
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.action).toBeUndefined();
  });

  it("does not offer the request action when there is no team context", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    const toastArg = await trigger402();
    expect(toastArg.action).toBeUndefined();
  });
});

describe("Studio session persistence", () => {
  const sessionKey = "kokao-studio-session-v1:1";

  it("saves in-progress work (prompt + generated caption) to localStorage", async () => {
    mockState.caption = "A persisted caption";
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-caption"));
    await waitFor(() => expect(screen.getByText("A persisted caption")).toBeTruthy());

    await waitFor(
      () => {
        const raw = localStorage.getItem(sessionKey);
        expect(raw).toBeTruthy();
        const s = JSON.parse(raw!);
        expect(s.form.prompt).toBe("A prompt long enough to pass validation");
        expect(s.captionResult.caption).toBe("A persisted caption");
      },
      { timeout: 2000 },
    );
  });

  it("restores the prompt, caption, and image from a saved session on mount", async () => {
    localStorage.setItem(
      sessionKey,
      JSON.stringify({
        v: 1,
        form: { prompt: "Restored brief text", tone: "professional" },
        captionResult: { caption: "Restored caption", hashtags: [] },
        captionPlatform: "instagram",
        imagePath: "/objects/t1/uploads/restored",
        draftId: 12,
      }),
    );
    renderPage();
    await waitFor(() => {
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
        "Restored brief text",
      );
      expect(screen.getByText("Restored caption")).toBeTruthy();
    });
    // The restored image renders from its stored server path (no base64 kept).
    const img = screen.getByAltText("Generated") as HTMLImageElement;
    expect(img.src).toContain("/api/storage/objects/t1/uploads/restored");
  });

  it("clears the stored session when the studio is emptied", async () => {
    localStorage.setItem(
      sessionKey,
      JSON.stringify({ v: 1, form: { prompt: "Old work", tone: "professional" } }),
    );
    renderPage();
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Old work"),
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "" } });
    await waitFor(() => expect(localStorage.getItem(sessionKey)).toBeNull(), { timeout: 2000 });
  });
});

describe("Studio AI amount spent line", () => {
  it("shows the combined amount on a generated caption when rates are set", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    await generateCaption("A caption with spend shown.");
    const line = screen.getByTestId("text-ai-spent-caption");
    expect(line.textContent).toContain("AI amount spent");
    expect(line.textContent).toContain("5.50");
  });

  it("shows the per-image amount on a generated image", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    await generateImage();
    const line = await screen.findByTestId("text-ai-spent-image");
    expect(line.textContent).toContain("11.00");
  });

  it("renders nothing when rates are zero or missing", async () => {
    mockState.aiSpendRates = { captionPaise: 0, imagePaise: 0 };
    await generateCaption("A caption without spend.");
    expect(screen.queryByTestId("text-ai-spent-caption")).toBeNull();
  });
});
