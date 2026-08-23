import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
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
  contentWrites: Array<{ kind: "create" | "update" | "delete"; vars: any }>;
  aiSpendRates: any;
  featureFlags: any;
  wallet: any;
  captionSpendPaise: number | null;
  imageSpendPaise: number | null;
  carouselSpendPaise: number | null;
  connections: {
    facebook: any;
    instagram: any;
    linkedin: any;
    twitter: any;
  };
  /** Seeded list returned by useListImageJobs; undefined = query still loading. */
  imageJobsList: any[] | undefined;
  /** Per-test override for the getImageJob direct function call. */
  getImageJobMock: ((id: number) => Promise<any>) | null;
} = {
  caption: "",
  lastCaptionVars: null,
  lastImageVars: null,
  lastCampaignVars: null,
  me: defaultMe(),
  campaignError: null,
  contentWrites: [],
  aiSpendRates: undefined,
  featureFlags: undefined,
  wallet: undefined,
  captionSpendPaise: null,
  imageSpendPaise: null,
  carouselSpendPaise: null,
  connections: defaultConnections(),
  imageJobsList: undefined,
  getImageJobMock: null,
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
    Promise.reject(
      Object.assign(new Error("stream unavailable in tests"), { status: 404 }),
    ),
}));

// Same for the SSE campaign stream: a 404 drives studio through its JSON
// fallback path (generateCampaign.mutate), which these tests assert against.
vi.mock("@/lib/campaignStream", () => ({
  streamCampaignRequest: () =>
    Promise.reject(
      Object.assign(new Error("stream unavailable in tests"), { status: 404 }),
    ),
}));

// The layered image editor pulls in react-konva/canvas, which jsdom can't
// run. Stub it with a minimal dialog that exposes the onSave contract so the
// Studio wiring (open button -> save -> draft update) is still testable.
vi.mock("@/components/image-editor", () => ({
  ImageEditorDialog: ({ open, initialLayers, onSave }: any) =>
    open ? (
      <button
        data-testid="mock-editor-save"
        data-initial-layers={JSON.stringify(initialLayers)}
        onClick={() =>
          onSave({
            imagePath: "/objects/t1/uploads/edited",
            b64: "ZWRpdGVk",
            layers: {
              version: 1,
              basePath: "/objects/t1/uploads/x",
              layers: [],
            },
          })
        }
      >
        mock save
      </button>
    ) : null,
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
        opts?.onSuccess?.({
          caption: mockState.caption,
          hashtags: [],
          ...(mockState.captionSpendPaise != null
            ? { spendPaise: mockState.captionSpendPaise }
            : {}),
        });
      },
    }),
    useGenerateImage: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastImageVars = vars;
        opts?.onSuccess?.({
          imagePath: "/objects/t1/uploads/x",
          b64Json: "aW1n",
          ...(mockState.imageSpendPaise != null
            ? { spendPaise: mockState.imageSpendPaise }
            : {}),
        });
      },
    }),
    useGenerateCarousel: () => ({
      isPending: false,
      mutate: (_vars: any, opts: any) => {
        opts?.onSuccess?.({
          title: "Carousel title",
          caption: "Carousel caption",
          hashtags: [],
          slides: [{ imagePrompt: "Slide one" }, { imagePrompt: "Slide two" }],
          carouselId: "car-1",
          ...(mockState.carouselSpendPaise != null
            ? { spendPaise: mockState.carouselSpendPaise }
            : {}),
        });
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
    useCreateContent: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.contentWrites.push({ kind: "create", vars });
        opts?.onSuccess?.({ id: 42, ...vars?.data });
      },
    }),
    useUpdateContent: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.contentWrites.push({ kind: "update", vars });
        opts?.onSuccess?.({ id: vars?.id, ...vars?.data });
      },
    }),
    useDeleteContent: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.contentWrites.push({ kind: "delete", vars });
        opts?.onSuccess?.(undefined);
      },
    }),
    useGetMe: () => ({ data: mockState.me }),
    useBillingRequestUpgrade: () => ({
      isPending: false,
      mutate: requestUpgradeSpy,
    }),
    useGetAiSpendRates: () => ({
      data: mockState.aiSpendRates,
      isLoading: false,
    }),
    useListFeatureFlags: () => ({
      data: mockState.featureFlags,
      isLoading: false,
    }),
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
    useListBrandKits: () => ({ data: [] }),
    useGetFacebookCredentials: () => ({
      data: mockState.connections.facebook,
      isLoading: false,
    }),
    useGetInstagramCredentials: () => ({
      data: mockState.connections.instagram,
      isLoading: false,
    }),
    useGetLinkedinStatus: () => ({
      data: mockState.connections.linkedin,
      isLoading: false,
    }),
    useGetTwitterStatus: () => ({
      data: mockState.connections.twitter,
      isLoading: false,
    }),
    // Async image jobs report "route disabled" so studio falls back to the
    // sync useGenerateImage path these tests drive.
    generateImageAsync: async () => {
      throw Object.assign(new Error("async jobs unavailable in tests"), {
        status: 404,
      });
    },
    // Image job list: undefined = loading (default), or the seeded array.
    useListImageJobs: () => ({
      data: mockState.imageJobsList,
      isLoading: mockState.imageJobsList === undefined,
    }),
    getListImageJobsQueryKey: () => ["list-image-jobs"],
    // Direct (non-hook) function that the resume loop calls each poll cycle.
    getImageJob: (id: number) => {
      if (mockState.getImageJobMock) return mockState.getImageJobMock(id);
      return Promise.resolve(undefined);
    },
  });
});

import { StudioPage } from "./studio";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <StudioPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function generateCaption(
  caption: string,
  platform: "twitter" | "instagram" = "twitter",
) {
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
  mockState.contentWrites = [];
  mockState.aiSpendRates = undefined;
  mockState.featureFlags = undefined;
  mockState.wallet = undefined;
  mockState.captionSpendPaise = null;
  mockState.imageSpendPaise = null;
  mockState.carouselSpendPaise = null;
  mockState.connections = defaultConnections();
  mockState.imageJobsList = undefined;
  mockState.getImageJobMock = null;
  window.history.replaceState({}, "", "/studio");
  toastSpy.mockClear();
  requestUpgradeSpy.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  cleanup();
});

describe("Studio Languages tab", () => {
  it("keeps the localization draft mounted across Studio tab switches", async () => {
    mockState.featureFlags = { videoGen: true, videoLocalization: true };
    window.history.replaceState({}, "", "/studio?tab=localize");
    const user = userEvent.setup();

    renderPage();
    const input = screen.getByTestId(
      "input-localize-script",
    ) as HTMLTextAreaElement;
    await user.type(input, "A localization draft that must survive.");

    await user.click(screen.getByTestId("tab-studio-image"));
    await user.click(screen.getByTestId("tab-studio-localize"));

    expect(
      (screen.getByTestId("input-localize-script") as HTMLTextAreaElement)
        .value,
    ).toBe("A localization draft that must survive.");
  });

  it("falls back to Image when a disabled localization URL is opened directly", () => {
    mockState.featureFlags = { videoGen: true, videoLocalization: false };
    window.history.replaceState({}, "", "/studio?tab=localize");

    renderPage();

    expect(screen.queryByTestId("tab-studio-localize")).toBeNull();
    expect(
      screen.getByTestId("tab-studio-image").getAttribute("data-state"),
    ).toBe("active");
  });
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
      screen.getByText(
        `${caption.length} / ${TWEET_MAX_LENGTH} characters for X`,
        {
          exact: false,
        },
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("shows no warning at exactly the limit", async () => {
    const caption = "b".repeat(TWEET_MAX_LENGTH);
    expect(tweetOverBy(caption)).toBe(0);
    await generateCaption(caption);
    expect(
      screen.getByText(
        `${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH} characters for X`,
        {
          exact: false,
        },
      ),
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
      screen.getByText(
        `${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`,
        {
          exact: false,
        },
      ),
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
      screen.getByText(
        `${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`,
        {
          exact: false,
        },
      ),
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

describe("Studio image editor", () => {
  it("shows an Edit image button after an image is generated", async () => {
    await generateImage();
    expect(screen.getByTestId("button-edit-image-studio")).toBeTruthy();
  });

  it("opens the editor and persists the saved image + layer doc to the draft", async () => {
    await generateImage();
    // Auto-save created the draft for the freshly generated image.
    await waitFor(() =>
      expect(mockState.contentWrites.some((w) => w.kind === "create")).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByTestId("button-edit-image-studio"));
    fireEvent.click(await screen.findByTestId("mock-editor-save"));
    // The saved result must replace the studio image and update the draft
    // with both the new imagePath and the re-editable imageLayers document.
    await waitFor(() => {
      const update = mockState.contentWrites.find(
        (w) =>
          w.kind === "update" &&
          w.vars?.data?.imagePath === "/objects/t1/uploads/edited",
      );
      expect(update).toBeTruthy();
      expect(update!.vars.data.imageLayers).toEqual({
        version: 1,
        basePath: "/objects/t1/uploads/x",
        layers: [],
      });
    });
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
    mockState.connections.twitter = {
      configured: true,
      connected: false,
      expired: false,
    };
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
    mockState.connections.linkedin = {
      configured: false,
      connected: true,
      expired: false,
    };
    renderPage();
    expect(
      screen
        .getByTestId("toggle-campaign-linkedin")
        .getAttribute("aria-pressed"),
    ).toBe("false");
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
    mockState.connections.facebook = {
      appConfigured: true,
      saved: true,
      verifyStatus: "failed",
    };
    renderPage();
    expect(
      screen
        .getByTestId("toggle-campaign-instagram")
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("toggle-campaign-facebook")
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("toggle-campaign-linkedin")
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("deselects an expired connection and routes its click to Accounts", () => {
    mockState.connections.twitter = {
      configured: true,
      connected: true,
      expired: true,
    };
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

describe("Studio Look pills", () => {
  it("sends no recipe when nothing is picked", async () => {
    await generateImage();
    expect(mockState.lastImageVars.data.promptRecipe).toBeUndefined();
  });

  it("sends the picked preset and drops it again when unpicked", async () => {
    const user = userEvent.setup();
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A prompt long enough to pass validation" },
    });

    await user.click(screen.getByTestId("toggle-look-product"));
    fireEvent.click(screen.getByTestId("button-generate-image"));
    await waitFor(() =>
      expect(mockState.lastImageVars.data.promptRecipe).toEqual({
        preset: "product",
      }),
    );

    // Radix single toggles deselect on a second click; the request has to
    // follow, or a tenant can never get back to an unstyled image.
    await user.click(screen.getByTestId("toggle-look-product"));
    fireEvent.click(screen.getByTestId("button-generate-image"));
    await waitFor(() =>
      expect(mockState.lastImageVars.data.promptRecipe).toBeUndefined(),
    );
  });

  it("sends a camera override alongside the preset", async () => {
    const user = userEvent.setup();
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A prompt long enough to pass validation" },
    });

    await user.click(screen.getByTestId("toggle-look-food"));
    await user.click(screen.getByTestId("button-toggle-look-gear"));
    await user.click(screen.getByTestId("select-look-aperture"));
    await user.click(screen.getByRole("option", { name: /f\/1\.4/ }));

    fireEvent.click(screen.getByTestId("button-generate-image"));
    await waitFor(() =>
      expect(mockState.lastImageVars.data.promptRecipe).toEqual({
        preset: "food",
        aperture: "f1.4",
      }),
    );
  });

  it("counts set overrides on the collapsed details toggle", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("button-toggle-look-gear"));
    await user.click(screen.getByTestId("select-look-lighting"));
    await user.click(screen.getByRole("option", { name: "Neon" }));
    await user.click(screen.getByTestId("button-toggle-look-gear"));
    expect(screen.getByTestId("button-toggle-look-gear").textContent).toBe(
      "Camera details (1)",
    );
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
    const btn = screen.getByTestId(
      "button-generate-image",
    ) as HTMLButtonElement;
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
    const btn = screen.getByTestId(
      "button-generate-image",
    ) as HTMLButtonElement;
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
    const btn = screen.getByTestId(
      "button-generate-image",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("keeps the caption button enabled when only the image quota is exhausted", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderPage();
    const btn = screen.getByTestId(
      "button-generate-caption",
    ) as HTMLButtonElement;
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
    // Members never see the server's owner-directed advice.
    expect(toastArg.description).toMatch(/ask your workspace owner/i);
    expect(toastArg.description).not.toMatch(/quota exhausted/i);
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
    // Owners keep the server's message — they can act on it.
    expect(toastArg.description).toMatch(/quota exhausted/i);
  });

  it("does not offer the request action when the upgradeRequests switch is off", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    mockState.me = { ...defaultMe(), team: { role: "member" } };
    mockState.featureFlags = { upgradeRequests: false };
    const toastArg = await trigger402();
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.action).toBeUndefined();
    // With upgrade requests disabled a member just gets a plain notice —
    // no owner-directed advice and no ask-the-owner nudge.
    expect(toastArg.description).toMatch(/out of AI quota/i);
    expect(toastArg.description).not.toMatch(/quota exhausted|upgrade/i);
  });

  it("does not offer the request action when there is no team context", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    const toastArg = await trigger402();
    expect(toastArg.action).toBeUndefined();
  });

  // Wallet-billed workspaces have no plan upgrades or credit packs — the 402
  // toast must point at recharging the prepaid wallet instead. These guard
  // the studio.tsx wiring that passes walletBilling into the shared helpers.
  it("shows wallet-recharge copy to the owner of a wallet-billed workspace", async () => {
    mockState.campaignError = {
      status: 402,
      message: "Quota exhausted, upgrade or buy a credit pack",
    };
    mockState.me = { ...defaultMe(), team: { role: "owner" } };
    mockState.wallet = { walletBilling: true };
    const toastArg = await trigger402();
    expect(toastArg.title).toBe("Wallet balance too low");
    expect(toastArg.description).toMatch(/recharge your prepaid wallet/i);
    // The server's credit-pack advice is wrong for wallet billing.
    expect(toastArg.description).not.toMatch(/credit pack|upgrade/i);
  });

  it("tells a member of a wallet-billed workspace to ask the owner to recharge", async () => {
    mockState.campaignError = { status: 402, message: "Quota exhausted" };
    mockState.me = { ...defaultMe(), team: { role: "member" } };
    mockState.wallet = { walletBilling: true };
    const toastArg = await trigger402();
    expect(toastArg.title).toBe("Wallet balance too low");
    expect(toastArg.description).toMatch(
      /ask your workspace owner to recharge the prepaid wallet/i,
    );
    expect(toastArg.description).not.toMatch(/upgrade/i);
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
    await waitFor(() =>
      expect(screen.getByText("A persisted caption")).toBeTruthy(),
    );

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
      expect(
        (screen.getByLabelText("Prompt") as HTMLTextAreaElement).value,
      ).toBe("Restored brief text");
      expect(screen.getByText("Restored caption")).toBeTruthy();
    });
    // The restored image renders from its stored server path (no base64 kept).
    const img = screen.getByAltText("Generated") as HTMLImageElement;
    expect(img.src).toContain("/api/storage/objects/t1/uploads/restored");
  });

  it("restores the image's snapshotted spend so a reopened draft shows the real amount", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    localStorage.setItem(
      sessionKey,
      JSON.stringify({
        v: 1,
        form: { prompt: "Restored brief text", tone: "professional" },
        imagePath: "/objects/t1/uploads/restored",
        imageSpendPaise: 2345,
      }),
    );
    renderPage();
    const line = await screen.findByTestId("text-ai-spent-image");
    expect(line.textContent).toContain("AI amount spent");
    expect(line.textContent).toContain("23.45");
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

  it("counts an image applied to all campaign platforms once", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A campaign prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-campaign"));
    await waitFor(() => expect(mockState.lastCampaignVars).toBeTruthy());
    const platforms: string[] = mockState.lastCampaignVars.data.platforms;
    expect(platforms.length).toBeGreaterThan(1);

    // Generate one image on the first card and apply it to ALL platforms:
    // one generation, one charge — the spend line must count it once.
    fireEvent.click(
      await screen.findByTestId(`button-campaign-image-${platforms[0]}`),
    );
    fireEvent.click(await screen.findByTestId("button-image-all-platforms"));

    const line = await screen.findByTestId("text-ai-spent-campaign");
    const expected = (platforms.length * 550 + 1100) / 100;
    expect(line.textContent).toContain(
      expected.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    );
  });
});

describe("Studio AI spend snapshot-first rendering", () => {
  // Guard against the spend lines silently reverting to the flat rate: in
  // cost_plus mode the response's spendPaise rarely equals the flat rate, so
  // each line must render the snapshot when present and the flat rate ONLY
  // when the snapshot is absent (legacy responses).
  it("caption line renders the response's spendPaise, not the flat rate", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    mockState.captionSpendPaise = 1234;
    await generateCaption("A caption with a real spend snapshot.");
    const line = screen.getByTestId("text-ai-spent-caption");
    expect(line.textContent).toContain("12.34");
    expect(line.textContent).not.toContain("5.50");
  });

  it("caption line falls back to the flat rate only when spendPaise is absent", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    mockState.captionSpendPaise = null;
    await generateCaption("A legacy caption without a snapshot.");
    expect(screen.getByTestId("text-ai-spent-caption").textContent).toContain(
      "5.50",
    );
  });

  it("image line renders the response's spendPaise, not the flat rate", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    mockState.imageSpendPaise = 4321;
    await generateImage();
    const line = await screen.findByTestId("text-ai-spent-image");
    expect(line.textContent).toContain("43.21");
    expect(line.textContent).not.toContain("11.00");
  });

  it("image line falls back to the flat rate only when spendPaise is absent", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    mockState.imageSpendPaise = null;
    await generateImage();
    expect(
      (await screen.findByTestId("text-ai-spent-image")).textContent,
    ).toContain("11.00");
  });

  it("a snapshotted spend shows even when the current flat rate is zero", async () => {
    // Admin later zeroed the rate; history must keep the real charge.
    mockState.aiSpendRates = { captionPaise: 0, imagePaise: 0 };
    mockState.captionSpendPaise = 1234;
    await generateCaption("A caption charged before the rate change.");
    expect(screen.getByTestId("text-ai-spent-caption").textContent).toContain(
      "12.34",
    );
  });

  async function generateCarousel() {
    renderPage();
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A carousel prompt long enough to pass validation" },
    });
    fireEvent.click(screen.getByTestId("button-generate-carousel"));
    await waitFor(() =>
      expect(screen.getByTestId("text-carousel-title")).toBeTruthy(),
    );
  }

  it("carousel line renders the copy generation's spendPaise, not the flat rate", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    mockState.carouselSpendPaise = 777;
    await generateCarousel();
    const line = screen.getByTestId("text-ai-spent-carousel");
    expect(line.textContent).toContain("7.77");
    expect(line.textContent).not.toContain("5.50");
  });

  it("carousel line falls back to the flat caption rate only when spendPaise is absent", async () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100 };
    mockState.carouselSpendPaise = null;
    await generateCarousel();
    expect(screen.getByTestId("text-ai-spent-carousel").textContent).toContain(
      "5.50",
    );
  });
});

describe("Studio image job resume on mount", () => {
  /**
   * These tests use real timers. The resume loop in resumeImageJobById waits
   * 2 000 ms between polls; waitFor is given a 6 000 ms ceiling to catch the
   * result after that real delay without flaking.
   *
   * Fake timers are deliberately avoided: RTL's waitFor polling is itself
   * timer-based, so using vi.useFakeTimers() causes it to deadlock on its own
   * retry setTimeout.
   */

  it("shows the in-progress panel for a queued job and surfaces the image after the first poll resolves as succeeded", async () => {
    mockState.imageJobsList = [
      {
        id: 42,
        status: "queued",
        prompt: "a great product photo",
        imagePath: null,
        layerDoc: null,
        spendPaise: null,
        stage: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const getImageJobSpy = vi.fn().mockResolvedValue({
      id: 99,
      status: "succeeded",
      imagePath: "/objects/t1/gen/99.png",
      layerDoc: null,
      spendPaise: null,
      stage: null,
      error: null,
    });
    mockState.getImageJobMock = getImageJobSpy;

    renderPage();

    // The mount effect fires once imageJobsList resolves. setImageJobBusy(true)
    // + setImageJobState are called synchronously inside the effect, so the
    // progress panel appears shortly after the first render cycle.
    await waitFor(
      () => expect(screen.getByTestId("image-job-progress")).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(screen.getByTestId("text-image-job-status").textContent).toContain(
      "queued and will start shortly",
    );

    // After the 2 000 ms poll delay the resume loop calls getImageJob and the
    // Promise resolves to "succeeded". Allow up to 6 000 ms for the real
    // timer to fire and React to flush the resulting state updates.
    await waitFor(
      () =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Image ready!" }),
        ),
      { timeout: 6000 },
    );
    expect(getImageJobSpy).toHaveBeenCalledWith(42);
  }, 10000 /* test-level timeout: real 2 s poll + margin */);

  it("surfaces the image immediately on the first poll when getImageJob already returns succeeded — no second cycle needed", async () => {
    // Job is still listed as "processing" (not yet done server-side when the
    // list loaded), but the very first poll call resolves to "succeeded".
    // Only one poll cycle (2 000 ms) must be required; the loop must exit
    // after detecting success rather than iterating again.
    mockState.imageJobsList = [
      {
        id: 99,
        status: "processing",
        prompt: "a quick background job",
        imagePath: null,
        layerDoc: null,
        spendPaise: null,
        stage: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const getImageJobSpy = vi.fn().mockResolvedValue({
      id: 99,
      status: "succeeded",
      imagePath: "/objects/t1/gen/99.png",
      layerDoc: null,
      spendPaise: null,
      stage: null,
      error: null,
    });
    mockState.getImageJobMock = getImageJobSpy;

    renderPage();

    await waitFor(
      () => expect(screen.getByTestId("image-job-progress")).toBeTruthy(),
      { timeout: 3000 },
    );

    // A single poll interval (2 000 ms) is all that is needed to surface the
    // image — the loop exits after the first success response.
    await waitFor(
      () =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Image ready!" }),
        ),
      { timeout: 6000 },
    );
    // Exactly one getImageJob call — the loop returned after the first success.
    expect(getImageJobSpy).toHaveBeenCalledTimes(1);
    expect(getImageJobSpy).toHaveBeenCalledWith(99);
  }, 10000 /* test-level timeout: real 2 s poll + margin */);
});

describe("Studio recent-generation strip — active-image filtering", () => {
  function makeSucceededJob(id: number, imagePath: string) {
    return {
      id,
      status: "succeeded",
      imagePath,
      prompt: `Job ${id} prompt`,
      spendPaise: null,
      layerDoc: null,
      stage: null,
    };
  }

  it("renders thumbnails for all succeeded jobs when no image is active", () => {
    mockState.imageJobsList = [
      makeSucceededJob(1, "/objects/t1/img1.png"),
      makeSucceededJob(2, "/objects/t1/img2.png"),
    ];
    renderPage();
    expect(screen.getByTestId("recent-image-jobs")).toBeTruthy();
    expect(screen.getByTestId("recent-job-1")).toBeTruthy();
    expect(screen.getByTestId("recent-job-2")).toBeTruthy();
  });

  it("hides the strip thumbnail for the job that is already displayed in the main panel", async () => {
    // The sync useGenerateImage mock resolves to imagePath "/objects/t1/uploads/x".
    // Putting a succeeded job with the same path in the list means after
    // generate it must vanish from the strip (same image, two places = confusing).
    mockState.imageJobsList = [
      makeSucceededJob(10, "/objects/t1/uploads/x"),
      makeSucceededJob(11, "/objects/t1/other.png"),
    ];
    await generateImage(); // sets imageResult.imagePath = "/objects/t1/uploads/x"
    // Job 10 (same path as active imageResult) must not appear in the strip.
    expect(screen.queryByTestId("recent-job-10")).toBeNull();
    // Job 11 (different path) still appears.
    expect(screen.getByTestId("recent-job-11")).toBeTruthy();
  });

  it("shows a job in the strip after its thumbnail is clicked and a different image becomes active", async () => {
    // Start: two jobs in the list, no active image result yet.
    mockState.imageJobsList = [
      makeSucceededJob(20, "/objects/t1/img20.png"),
      makeSucceededJob(21, "/objects/t1/img21.png"),
    ];
    renderPage();
    // Click job 20 — its path becomes the active imageResult.
    fireEvent.click(screen.getByTestId("recent-job-20"));
    // Job 20 is now active → must be hidden.
    expect(screen.queryByTestId("recent-job-20")).toBeNull();
    // Job 21 is still different → must remain.
    expect(screen.getByTestId("recent-job-21")).toBeTruthy();
  });

  it("loads a recent thumbnail only once when the same click target fires twice", () => {
    mockState.imageJobsList = [
      makeSucceededJob(22, "/objects/t1/img22.png"),
    ];
    renderPage();

    // Keep the original node reference to model a rapid second click that
    // reaches an already-detached thumbnail before the browser discards it.
    const thumbnail = screen.getByTestId("recent-job-22");
    fireEvent.click(thumbnail);
    fireEvent.click(thumbnail);

    expect(
      screen
        .getByTestId("studio-image-zoom-trigger")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe(
      "/api/storage/objects/t1/img22.png",
    );
    expect(screen.queryByTestId("recent-job-22")).toBeNull();
    expect(
      toastSpy.mock.calls.filter(
        ([toast]) => toast?.title === "Image loaded",
      ),
    ).toHaveLength(1);
  });

  it("re-shows the original job thumbnail after its image is edited and saved with a new path", async () => {
    // The sync useGenerateImage mock resolves to imagePath "/objects/t1/uploads/x".
    // Job 60 shares that path, so it is hidden once generation completes (the
    // active-image filter keeps the same image from appearing twice).
    mockState.imageJobsList = [
      makeSucceededJob(60, "/objects/t1/uploads/x"),
      makeSucceededJob(61, "/objects/t1/other.png"),
    ];
    await generateImage(); // imageResult.imagePath = "/objects/t1/uploads/x"

    // Job 60 is hidden: it matches the active imageResult path.
    expect(screen.queryByTestId("recent-job-60")).toBeNull();
    // Job 61 is unrelated and still visible.
    expect(screen.getByTestId("recent-job-61")).toBeTruthy();

    // Open the image editor and save — the mock editor resolves to the new
    // path "/objects/t1/uploads/edited", which updates imageResult.imagePath.
    fireEvent.click(screen.getByTestId("button-edit-image-studio"));
    fireEvent.click(await screen.findByTestId("mock-editor-save"));

    // After the save, imageResult.imagePath is "/objects/t1/uploads/edited".
    // Job 60's imagePath ("/objects/t1/uploads/x") no longer matches, so it
    // reappears in the strip as an unedited alternative the user can still load.
    // This reappearance is intentional: the original generation is a valid
    // fallback the user may want to compare against the edited version.
    await waitFor(() =>
      expect(screen.getByTestId("recent-job-60")).toBeTruthy(),
    );

    // Job 61 remains visible throughout.
    expect(screen.getByTestId("recent-job-61")).toBeTruthy();
  });

  it("replaces edited layers with the selected job's layer document", async () => {
    const selectedJobLayers = {
      version: 1,
      basePath: "/objects/t1/with-layers-original.png",
      layers: [{ id: "selected-job-text", type: "text", text: "Job layer" }],
    };
    mockState.imageJobsList = [
      makeSucceededJob(70, "/objects/t1/no-layers.png"),
      {
        ...makeSucceededJob(71, "/objects/t1/with-layers.png"),
        layerDoc: selectedJobLayers,
      },
    ];

    // Start with an edited image so imageLayers contains the editor's saved
    // document rather than null.
    await generateImage();
    fireEvent.click(screen.getByTestId("button-edit-image-studio"));
    fireEvent.click(await screen.findByTestId("mock-editor-save"));
    await waitFor(() =>
      expect(screen.getByTestId("recent-job-70")).toBeTruthy(),
    );

    // A job with no layer document must clear the edited image's layers.
    fireEvent.click(screen.getByTestId("recent-job-70"));
    fireEvent.click(screen.getByTestId("button-edit-image-studio"));
    expect(
      screen
        .getByTestId("mock-editor-save")
        .getAttribute("data-initial-layers"),
    ).toBe("null");

    // Loading a different job must use its own saved layer document, not the
    // original edited image's layers or the preceding job's null value.
    fireEvent.click(screen.getByTestId("recent-job-71"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("mock-editor-save")
          .getAttribute("data-initial-layers"),
      ).toBe(JSON.stringify(selectedJobLayers)),
    );
  });
});

describe("Studio recent-generation strip — hidden after save/discard", () => {
  function makeSucceededJob(id: number, imagePath: string) {
    return {
      id,
      status: "succeeded",
      imagePath,
      prompt: `Job ${id} prompt`,
      spendPaise: null,
      layerDoc: null,
      stage: null,
    };
  }

  it("hides the job's thumbnail from the strip after the image is saved to the library", async () => {
    // The sync useGenerateImage mock resolves to imagePath "/objects/t1/uploads/x";
    // job 30 shares that path, job 31 does not.
    mockState.imageJobsList = [
      makeSucceededJob(30, "/objects/t1/uploads/x"),
      makeSucceededJob(31, "/objects/t1/other.png"),
    ];
    await generateImage();
    fireEvent.click(screen.getByTestId("button-save-draft"));
    // After save the studio resets (imageResult clears), so only the
    // dismissal — not the active-image filter — can keep job 30 hidden.
    await waitFor(() =>
      expect(screen.queryByTestId("recent-job-30")).toBeNull(),
    );
    expect(screen.getByTestId("recent-job-31")).toBeTruthy();
  });

  it("hides the job's thumbnail from the strip after the image is discarded", async () => {
    mockState.imageJobsList = [
      makeSucceededJob(40, "/objects/t1/uploads/x"),
      makeSucceededJob(41, "/objects/t1/other.png"),
    ];
    await generateImage();
    fireEvent.click(screen.getByTestId("button-discard-draft"));
    await waitFor(() =>
      expect(screen.queryByTestId("recent-job-40")).toBeNull(),
    );
    expect(screen.getByTestId("recent-job-41")).toBeTruthy();
  });

  it("keeps a saved job hidden after the Studio remounts (sessionStorage persistence)", async () => {
    mockState.imageJobsList = [
      makeSucceededJob(50, "/objects/t1/uploads/x"),
      makeSucceededJob(51, "/objects/t1/other.png"),
    ];
    await generateImage();
    fireEvent.click(screen.getByTestId("button-save-draft"));
    await waitFor(() =>
      expect(screen.queryByTestId("recent-job-50")).toBeNull(),
    );
    // Simulate navigating away and back: unmount everything, render fresh.
    cleanup();
    renderPage();
    expect(screen.queryByTestId("recent-job-50")).toBeNull();
    expect(screen.getByTestId("recent-job-51")).toBeTruthy();
  });
});
