import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { IMAGE_TWEAKS } from "@workspace/studio-presets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
 * Guard: the campaign post card's X character warning must be derived from the
 * shared @workspace/social-limits helpers, so what the user sees always
 * matches what the server does when publishing. Expected values in these
 * tests are computed FROM the shared helpers — if the component drifts to a
 * local copy of the limit or its own counting, these assertions break.
 */

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Stub the layered editor (Konva can't run in jsdom): when open, expose a
// button that simulates the user saving an edited image.
vi.mock("@/components/image-editor", () => ({
  ImageEditorDialog: ({ open, onSave }: any) =>
    open ? (
      <button
        data-testid="stub-editor-save"
        onClick={() =>
          onSave({
            imagePath: "/objects/t/edited/new",
            b64: "edited-b64",
            layers: { version: 1, basePath: "/objects/t/uploads/x", layers: [] },
          })
        }
      >
        stub save
      </button>
    ) : null,
}));

// Resilient mock: unknown hooks fall back to an idle stub, so adding a new
// hook to the component does not break these tests.
const generateImageMutate = vi.hoisted(() => vi.fn());
const createContentMutate = vi.hoisted(() => vi.fn());
const updateContentMutate = vi.hoisted(() => vi.fn());
const mockState = vi.hoisted(() => ({ me: null as any, wallet: null as any }));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGenerateImage: () => ({ ...idleMutation(), mutate: generateImageMutate }),
    useCreateContent: () => ({ ...idleMutation(), mutate: createContentMutate }),
    useUpdateContent: () => ({ ...idleMutation(), mutate: updateContentMutate }),
    useGetMe: () => ({ data: mockState.me }),
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
  });
});

import { CampaignPostCard } from "./campaign-post-card";

function renderCard(platform: string, caption: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CampaignPostCard
        post={{ platform, caption, hashtags: [], imagePrompt: "" } as any}
        brief="test brief"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.me = null;
  mockState.wallet = null;
  toastSpy.mockClear();
  generateImageMutate.mockClear();
  cleanup();
});

describe("CampaignPostCard 402 quota toast copy", () => {
  // Trigger a 402 by clicking Generate Image and invoking the mutation's
  // onError callback with the given error.
  const trigger402 = (error: any) => {
    renderCard("instagram", "A caption for the card.");
    fireEvent.click(screen.getByTestId("button-campaign-image-instagram"));
    const options = generateImageMutate.mock.calls[0][1];
    act(() => options.onError(error));
    return toastSpy.mock.calls[0][0];
  };

  it("shows the server's wallet-specific shortfall message to a wallet-billed owner", () => {
    mockState.wallet = { walletBilling: true };
    mockState.me = { limits: { images: -1 }, usage: { images: 0 }, team: { role: "owner" } };
    const serverMsg =
      "This image needs 2 generations and your wallet balance can't cover it. Recharge to continue.";
    const toastArg = trigger402({ status: 402, message: serverMsg });
    expect(toastArg.title).toBe("Wallet balance too low");
    expect(toastArg.description).toBe(serverMsg);
  });

  it("tells a wallet-billed member to ask the owner to recharge", () => {
    mockState.wallet = { walletBilling: true };
    mockState.me = { limits: { images: -1 }, usage: { images: 0 }, team: { role: "member" } };
    const toastArg = trigger402({ status: 402, message: "Quota exhausted" });
    expect(toastArg.title).toBe("Wallet balance too low");
    expect(toastArg.description).toMatch(
      /ask your workspace owner to recharge the prepaid wallet/i,
    );
    expect(toastArg.description).not.toMatch(/upgrade/i);
  });

  it("keeps quota copy with the server message for a quota-billed owner", () => {
    mockState.me = { limits: { images: -1 }, usage: { images: 0 }, team: { role: "owner" } };
    const toastArg = trigger402({ status: 402, message: "Monthly quota exceeded. Upgrade your plan." });
    expect(toastArg.title).toBe("Quota Reached");
    expect(toastArg.description).toMatch(/quota exceeded/i);
  });
});

describe("CampaignPostCard X character warning", () => {
  it("shows no over-limit warning for an under-limit twitter caption", () => {
    const caption = "Short caption under the limit.";
    expect(isOverTweetLimit(caption)).toBe(false);
    renderCard("twitter", caption);
    expect(
      screen.getByText(`${caption.length} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("shows no over-limit warning for an exactly at-limit caption", () => {
    const caption = "a".repeat(TWEET_MAX_LENGTH);
    expect(isOverTweetLimit(caption)).toBe(false);
    expect(tweetOverBy(caption)).toBe(0);
    renderCard("twitter", caption);
    expect(
      screen.getByText(`${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("warns with the shared helper's over-by count for an over-limit caption", () => {
    const caption = "a".repeat(TWEET_MAX_LENGTH + 20);
    expect(isOverTweetLimit(caption)).toBe(true);
    renderCard("twitter", caption);
    const warning = screen.getByText(
      `${caption.length} / ${TWEET_MAX_LENGTH} characters for X`,
      { exact: false },
    );
    // The displayed over-by number must equal the shared helper's output.
    expect(warning.textContent).toContain(`${tweetOverBy(caption)} over`);
    expect(warning.textContent).toContain(
      `will post as a thread of ${splitIntoTweets(caption).length} tweets on X`,
    );
    expect(warning.textContent).not.toContain("trimmed");
  });

  it("renders no X warning for non-twitter platforms", () => {
    renderCard("linkedin", "a".repeat(TWEET_MAX_LENGTH + 50));
    expect(screen.queryByText(/characters for X/i)).toBeNull();
  });
});

describe("CampaignPostCard Threads character warning", () => {
  it("shows count without warning for an under-limit threads caption", () => {
    const caption = "Short caption under the Threads limit.";
    renderCard("threads", caption);
    expect(
      screen.getByText(`${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a chain/i)).toBeNull();
  });

  it("warns with the shared helper's chunk count for an over-limit threads caption", () => {
    const caption = "t".repeat(THREADS_MAX_LENGTH + 40);
    const chunks = chunkOnWhitespace(caption, THREADS_MAX_LENGTH);
    expect(chunks.length).toBeGreaterThan(1);
    renderCard("threads", caption);
    const warning = screen.getByText(
      `${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `will post as a chain of ${chunks.length} connected posts on Threads`,
    );
  });

  it("renders no Threads warning for other platforms", () => {
    renderCard("twitter", "t".repeat(THREADS_MAX_LENGTH + 40));
    expect(screen.queryByText(/characters for Threads/i)).toBeNull();
  });
});

describe("CampaignPostCard LinkedIn character warning", () => {
  it("shows count without warning for an under-limit linkedin caption", () => {
    const caption = "Short caption under the LinkedIn limit.";
    expect(isOverLinkedinLimit(caption)).toBe(false);
    renderCard("linkedin", caption);
    expect(
      screen.getByText(`${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/follow-up comment/i)).toBeNull();
  });

  it("warns with the shared helper's comment count for an over-limit linkedin caption", () => {
    const caption = "l".repeat(LINKEDIN_MAX_LENGTH + 100);
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const commentCount = splitForLinkedin(caption).comments.length;
    renderCard("linkedin", caption);
    const warning = screen.getByText(
      `${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"} on LinkedIn`,
    );
  });

  it("renders no LinkedIn warning for other platforms", () => {
    renderCard("twitter", "l".repeat(LINKEDIN_MAX_LENGTH + 100));
    expect(screen.queryByText(/characters for LinkedIn/i)).toBeNull();
  });
});

/**
 * Guard: campaign variant images offer the SAME quick style tweak chips as
 * the single-image Studio card, sourced from the shared
 * @workspace/studio-presets IMAGE_TWEAKS list. Clicking a chip regenerates
 * the variant's image with the shared instruction appended to the prompt,
 * and the result still flows through onImageGenerated (which powers the
 * "use for all platforms" flow).
 */
describe("CampaignPostCard image style tweak chips", () => {
  function renderWithImage(onImageGenerated?: (platform: string, image: unknown) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <CampaignPostCard
          post={{ platform: "instagram", caption: "A cozy cafe post", hashtags: [], imagePrompt: "A cozy cafe interior" } as any}
          brief="test brief"
          image={{ imagePath: "/objects/t/uploads/x", b64Json: "aaaa" }}
          onImageGenerated={onImageGenerated as any}
        />
      </QueryClientProvider>,
    );
  }

  it("shows no tweak chips before an image exists", () => {
    renderCard("instagram", "caption");
    for (const t of IMAGE_TWEAKS) {
      expect(
        screen.queryByTestId(`button-campaign-image-tweak-instagram-${t.label.toLowerCase().replace(/\s+/g, "-")}`),
      ).toBeNull();
    }
  });

  it("renders every shared tweak chip once an image exists", () => {
    renderWithImage();
    for (const t of IMAGE_TWEAKS) {
      expect(
        screen.getByTestId(`button-campaign-image-tweak-instagram-${t.label.toLowerCase().replace(/\s+/g, "-")}`).textContent,
      ).toBe(t.label);
    }
  });

  it("clicking a chip regenerates with the shared instruction appended and reports via onImageGenerated", () => {
    generateImageMutate.mockClear();
    const onImageGenerated = vi.fn();
    renderWithImage(onImageGenerated);
    const tweak = IMAGE_TWEAKS[0];
    fireEvent.click(
      screen.getByTestId(`button-campaign-image-tweak-instagram-${tweak.label.toLowerCase().replace(/\s+/g, "-")}`),
    );
    expect(generateImageMutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = generateImageMutate.mock.calls[0];
    expect(vars.data.prompt).toBe(`A cozy cafe interior ${tweak.instruction}`);
    const res = { imagePath: "/objects/t/uploads/y", b64Json: "bbbb" };
    (opts as any).onSuccess(res);
    expect(onImageGenerated).toHaveBeenCalledWith("instagram", res);
  });

  it("successful image generation invalidates the /me quota query", async () => {
    generateImageMutate.mockClear();
    const { getGetMeQueryKey } = await import("@workspace/api-client-react");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <CampaignPostCard
          post={{ platform: "instagram", caption: "A cozy cafe post", hashtags: [], imagePrompt: "A cozy cafe interior" } as any}
          brief="test brief"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-campaign-image-instagram"));
    const [, opts] = generateImageMutate.mock.calls[0];
    (opts as any).onSuccess({ imagePath: "/objects/t/uploads/z", b64Json: "cccc" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetMeQueryKey() });
  });

  it("plain regenerate sends the untweaked prompt", () => {
    generateImageMutate.mockClear();
    renderWithImage();
    fireEvent.click(screen.getByTestId("button-campaign-image-instagram"));
    expect(generateImageMutate).toHaveBeenCalledTimes(1);
    expect(generateImageMutate.mock.calls[0][0].data.prompt).toBe("A cozy cafe interior");
  });
});

describe("CampaignPostCard image buttons when the monthly image quota is exhausted", () => {
  function renderWithImage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <CampaignPostCard
          post={{ platform: "instagram", caption: "A cozy cafe post", hashtags: [], imagePrompt: "A cozy cafe interior" } as any}
          brief="test brief"
          image={{ imagePath: "/objects/t/uploads/x", b64Json: "aaaa" }}
        />
      </QueryClientProvider>,
    );
  }

  it("disables the Image button and shows a visible plan-limit hint when quota and credits are zero", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderCard("instagram", "caption");
    const btn = screen.getByTestId("button-campaign-image-instagram") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // The hint must be user-visible text (disabled buttons can't show tooltips).
    expect(screen.getByTestId("image-quota-hint-instagram").textContent).toMatch(
      /image limit reached/i,
    );
  });

  it("disables the tweak chips and Regenerate when an image exists and quota is exhausted", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderWithImage();
    expect(
      (screen.getByTestId("button-campaign-image-instagram") as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const t of IMAGE_TWEAKS) {
      const chip = screen.getByTestId(
        `button-campaign-image-tweak-instagram-${t.label.toLowerCase().replace(/\s+/g, "-")}`,
      ) as HTMLButtonElement;
      expect(chip.disabled).toBe(true);
    }
  });

  it("shows wallet-recharge copy (not credit-pack copy) for wallet-billed workspaces", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    mockState.wallet = { walletBilling: true };
    renderCard("instagram", "caption");
    const hint = screen.getByTestId("image-quota-hint-instagram").textContent ?? "";
    expect(hint).toMatch(/recharge your prepaid wallet/i);
    expect(hint).not.toMatch(/upgrade|buy credits/i);
  });

  it("keeps the upgrade/credit copy for quota-billed workspaces", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    mockState.wallet = { walletBilling: false };
    renderCard("instagram", "caption");
    const hint = screen.getByTestId("image-quota-hint-instagram").textContent ?? "";
    expect(hint).toMatch(/upgrade your plan or buy credits/i);
    expect(hint).not.toMatch(/wallet/i);
  });

  it("keeps the Image button enabled when image credits remain", () => {
    mockState.me = {
      usage: { captions: 2, images: 5 },
      limits: { captions: 10, images: 5 },
      credits: { captionCredits: 0, imageCredits: 2 },
    };
    renderCard("instagram", "caption");
    expect(
      (screen.getByTestId("button-campaign-image-instagram") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByTestId("image-quota-hint-instagram")).toBeNull();
  });

  it("keeps the Image button enabled on unlimited plans", () => {
    mockState.me = {
      usage: { captions: 2, images: 500 },
      limits: { captions: -1, images: -1 },
      credits: { captionCredits: 0, imageCredits: 0 },
    };
    renderCard("instagram", "caption");
    expect(
      (screen.getByTestId("button-campaign-image-instagram") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

/**
 * The layered image editor must be reachable from every campaign post image,
 * and a saved edit must replace the image and persist its layer doc when the
 * post is saved to the library.
 */
describe("CampaignPostCard image editor", () => {
  function renderEditable(onImageEdited?: (...args: unknown[]) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <CampaignPostCard
          post={{ platform: "instagram", caption: "A cozy cafe post", hashtags: [], imagePrompt: "A cozy cafe interior" } as any}
          brief="test brief"
          {...(onImageEdited
            ? {
                image: { imagePath: "/objects/t/uploads/x", b64Json: "aaaa" },
                imageLayers: null,
                onImageEdited: onImageEdited as any,
              }
            : {})}
        />
      </QueryClientProvider>,
    );
  }

  it("shows no Edit image button before an image exists", () => {
    renderCard("instagram", "caption");
    expect(screen.queryByTestId("button-campaign-edit-image-instagram")).toBeNull();
  });

  it("reports edited image + layers to the parent when controlled", () => {
    const onImageEdited = vi.fn();
    renderEditable(onImageEdited);
    fireEvent.click(screen.getByTestId("button-campaign-edit-image-instagram"));
    fireEvent.click(screen.getByTestId("stub-editor-save"));
    expect(onImageEdited).toHaveBeenCalledWith(
      "instagram",
      { imagePath: "/objects/t/edited/new", b64Json: "edited-b64", spendPaise: null },
      { version: 1, basePath: "/objects/t/uploads/x", layers: [] },
    );
  });

  it("saves the edited image and its layer doc when uncontrolled", () => {
    createContentMutate.mockClear();
    generateImageMutate.mockClear();
    renderCard("instagram", "caption");
    // Generate an image locally first.
    fireEvent.click(screen.getByTestId("button-campaign-image-instagram"));
    const [, opts] = generateImageMutate.mock.calls[0];
    act(() => {
      opts.onSuccess({ imagePath: "/objects/t/uploads/x", b64Json: "aaaa" });
    });
    // Edit it, then save the post.
    fireEvent.click(screen.getByTestId("button-campaign-edit-image-instagram"));
    fireEvent.click(screen.getByTestId("stub-editor-save"));
    fireEvent.click(screen.getByText("Save"));
    expect(createContentMutate).toHaveBeenCalledTimes(1);
    const [vars] = createContentMutate.mock.calls[0];
    expect(vars.data.imagePath).toBe("/objects/t/edited/new");
    expect(vars.data.imageLayers).toEqual({
      version: 1,
      basePath: "/objects/t/uploads/x",
      layers: [],
    });
  });
});
