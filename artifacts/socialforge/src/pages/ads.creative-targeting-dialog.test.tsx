import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the two sibling approval dialogs on the Ads page:
 *
 * CreativeDraftDialog
 * - Renders ad text, landing URL, and the content-library image picker.
 * - Submits targetType "creative" / action "create" with the campaign id,
 *   trimmed text, and OMITS imagePath / landingUrl when unset (the server
 *   rejects empty strings and validates https on landingUrl).
 *
 * TargetingDraftDialog
 * - Renders all four facets and the search box; results come from the
 *   LinkedIn targeting search hook.
 * - Submits targetType "campaign" / action "update" with targetId set to
 *   the campaign id, and includes ONLY the targeting arrays for facets
 *   that have selections (a present-but-empty array would be interpreted
 *   as "clear this facet" server-side).
 */

// Radix dialogs need a few APIs jsdom doesn't implement.
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

const createDraftMutate = vi.fn();

const mockState = {
  content: [] as Array<{ id: number; imagePath: string | null }>,
  searchResults: [] as Array<{ urn: string; name: string }>,
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useCreateAdDraft: () => ({ mutate: createDraftMutate, isPending: false }),
    useListContent: () => ({ data: mockState.content, isLoading: false }),
    useSearchLinkedinTargeting: (
      _params: unknown,
      options?: { query?: { enabled?: boolean } },
    ) => ({
      data:
        options?.query?.enabled === false
          ? undefined
          : { results: mockState.searchResults },
      isFetching: false,
    }),
    getSearchLinkedinTargetingQueryKey: (params?: unknown) => [
      "/api/ads/linkedin/targeting-search",
      params,
    ],
  });
});

// Imported after the mock so the mocked module is picked up.
import { CreativeDraftDialog, TargetingDraftDialog } from "./ads";

const CAMPAIGN = { id: "urn:li:sponsoredCampaign:123", name: "Q4 Push" };

let queryClient: QueryClient;

function wrap(ui: React.ReactElement) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function renderCreativeDialog(onClose: () => void = () => {}) {
  return wrap(
    <CreativeDraftDialog connectionId={7} campaign={CAMPAIGN} onClose={onClose} />,
  );
}

function renderTargetingDialog(onClose: () => void = () => {}) {
  return wrap(
    <TargetingDraftDialog connectionId={7} campaign={CAMPAIGN} onClose={onClose} />,
  );
}

function submittedPayload(): Record<string, unknown> {
  expect(createDraftMutate).toHaveBeenCalledTimes(1);
  return (createDraftMutate.mock.calls[0]![0] as { data: Record<string, unknown> })
    .data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.content = [];
  mockState.searchResults = [];
});

afterEach(() => {
  cleanup();
});

describe("CreativeDraftDialog rendering", () => {
  it("shows text, landing URL, and the empty-library message when no images exist", () => {
    renderCreativeDialog();
    expect(screen.getByText(`Add a creative to "${CAMPAIGN.name}"`)).toBeTruthy();
    expect(screen.getByTestId("input-creative-text")).toBeTruthy();
    expect(screen.getByTestId("input-creative-landing")).toBeTruthy();
    expect(
      screen.getByText(/No images in your library yet/),
    ).toBeTruthy();
  });

  it("renders one picker button per library item that has an image", () => {
    mockState.content = [
      { id: 1, imagePath: "/objects/t1/uploads/a" },
      { id: 2, imagePath: null },
      { id: 3, imagePath: "/objects/t1/uploads/b" },
    ];
    renderCreativeDialog();
    expect(screen.getByTestId("button-creative-image-1")).toBeTruthy();
    expect(screen.queryByTestId("button-creative-image-2")).toBeNull();
    expect(screen.getByTestId("button-creative-image-3")).toBeTruthy();
  });

  it("keeps Save disabled until ad text is entered", () => {
    renderCreativeDialog();
    const submit = screen.getByTestId(
      "button-submit-creative-draft",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-creative-text"), {
      target: { value: "   " },
    });
    expect(
      (screen.getByTestId("button-submit-creative-draft") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("input-creative-text"), {
      target: { value: "Buy now" },
    });
    expect(
      (screen.getByTestId("button-submit-creative-draft") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("CreativeDraftDialog payload", () => {
  it("submits a text-only creative create and OMITS imagePath and landingUrl", () => {
    renderCreativeDialog();
    fireEvent.change(screen.getByTestId("input-creative-text"), {
      target: { value: "  Fresh offer inside  " },
    });
    fireEvent.click(screen.getByTestId("button-submit-creative-draft"));

    const payload = submittedPayload();
    expect(payload.connectionId).toBe(7);
    expect(payload.targetType).toBe("creative");
    expect(payload.action).toBe("create");
    expect(payload.campaignId).toBe(CAMPAIGN.id);
    expect(payload.text).toBe("Fresh offer inside");
    expect(payload.imagePath).toBeUndefined();
    expect(payload.landingUrl).toBeUndefined();
    // Creative creates carry no update-style fields.
    expect(payload.targetId).toBeUndefined();
    expect(payload.name).toBeUndefined();
    expect(typeof payload.idempotencyKey).toBe("string");
  });

  it("includes the selected image and trimmed landing URL", () => {
    mockState.content = [{ id: 1, imagePath: "/objects/t1/uploads/a" }];
    renderCreativeDialog();
    fireEvent.change(screen.getByTestId("input-creative-text"), {
      target: { value: "With image" },
    });
    fireEvent.change(screen.getByTestId("input-creative-landing"), {
      target: { value: "  https://example.com/offer  " },
    });
    fireEvent.click(screen.getByTestId("button-creative-image-1"));
    fireEvent.click(screen.getByTestId("button-submit-creative-draft"));

    const payload = submittedPayload();
    expect(payload.imagePath).toBe("/objects/t1/uploads/a");
    expect(payload.landingUrl).toBe("https://example.com/offer");
  });

  it("deselecting the image again omits imagePath", () => {
    mockState.content = [{ id: 1, imagePath: "/objects/t1/uploads/a" }];
    renderCreativeDialog();
    fireEvent.change(screen.getByTestId("input-creative-text"), {
      target: { value: "Toggled off" },
    });
    fireEvent.click(screen.getByTestId("button-creative-image-1"));
    fireEvent.click(screen.getByTestId("button-creative-image-1"));
    fireEvent.click(screen.getByTestId("button-submit-creative-draft"));

    const payload = submittedPayload();
    expect(payload.imagePath).toBeUndefined();
  });
});

describe("TargetingDraftDialog rendering", () => {
  it("shows all four facet buttons and the search input", () => {
    renderTargetingDialog();
    expect(screen.getByText(`Edit targeting for "${CAMPAIGN.name}"`)).toBeTruthy();
    expect(screen.getByTestId("button-facet-locations")).toBeTruthy();
    expect(screen.getByTestId("button-facet-industries")).toBeTruthy();
    expect(screen.getByTestId("button-facet-jobFunctions")).toBeTruthy();
    expect(screen.getByTestId("button-facet-titles")).toBeTruthy();
    expect(screen.getByTestId("input-targeting-search")).toBeTruthy();
  });

  it("keeps Save disabled until at least one entity is selected", () => {
    mockState.searchResults = [{ urn: "urn:li:geo:1", name: "India" }];
    renderTargetingDialog();
    const submit = screen.getByTestId(
      "button-submit-targeting-draft",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "In" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:geo:1"));
    expect(
      (screen.getByTestId("button-submit-targeting-draft") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // Selection renders as a removable badge and clears the search box.
    expect(screen.getByText("India")).toBeTruthy();
    expect(
      (screen.getByTestId("input-targeting-search") as HTMLInputElement).value,
    ).toBe("");
  });

  it("removing the only selection disables Save again", () => {
    mockState.searchResults = [{ urn: "urn:li:geo:1", name: "India" }];
    renderTargetingDialog();
    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "In" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:geo:1"));
    fireEvent.click(screen.getByTestId("button-remove-targeting-urn:li:geo:1"));
    expect(
      (screen.getByTestId("button-submit-targeting-draft") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("TargetingDraftDialog payload", () => {
  it("submits a campaign update with ONLY the selected facet included", () => {
    mockState.searchResults = [{ urn: "urn:li:geo:1", name: "India" }];
    renderTargetingDialog();
    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "In" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:geo:1"));
    fireEvent.click(screen.getByTestId("button-submit-targeting-draft"));

    const payload = submittedPayload();
    expect(payload.connectionId).toBe(7);
    expect(payload.targetType).toBe("campaign");
    expect(payload.action).toBe("update");
    expect(payload.targetId).toBe(CAMPAIGN.id);
    expect(payload.targetingLocations).toEqual([
      { urn: "urn:li:geo:1", name: "India" },
    ]);
    // Untouched facets must be ABSENT, not empty arrays — an empty array
    // would clear that facet on the campaign.
    expect("targetingIndustries" in payload).toBe(false);
    expect("targetingJobFunctions" in payload).toBe(false);
    expect("targetingTitles" in payload).toBe(false);
    // Targeting updates never send create-style fields.
    expect(payload.campaignId).toBeUndefined();
    expect(payload.name).toBeUndefined();
    expect(typeof payload.idempotencyKey).toBe("string");
  });

  it("keys each selection under its own facet across facet switches", () => {
    renderTargetingDialog();

    mockState.searchResults = [{ urn: "urn:li:geo:1", name: "India" }];
    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "In" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:geo:1"));

    fireEvent.click(screen.getByTestId("button-facet-titles"));
    mockState.searchResults = [{ urn: "urn:li:title:9", name: "Product Manager" }];
    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "Pro" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:title:9"));

    fireEvent.click(screen.getByTestId("button-submit-targeting-draft"));
    const payload = submittedPayload();
    expect(payload.targetingLocations).toEqual([
      { urn: "urn:li:geo:1", name: "India" },
    ]);
    expect(payload.targetingTitles).toEqual([
      { urn: "urn:li:title:9", name: "Product Manager" },
    ]);
    expect("targetingIndustries" in payload).toBe(false);
    expect("targetingJobFunctions" in payload).toBe(false);
  });

  it("does not add the same entity twice", () => {
    mockState.searchResults = [{ urn: "urn:li:geo:1", name: "India" }];
    renderTargetingDialog();
    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "In" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:geo:1"));
    fireEvent.change(screen.getByTestId("input-targeting-search"), {
      target: { value: "In" },
    });
    fireEvent.click(screen.getByTestId("button-targeting-result-urn:li:geo:1"));
    fireEvent.click(screen.getByTestId("button-submit-targeting-draft"));

    const payload = submittedPayload();
    expect(payload.targetingLocations).toEqual([
      { urn: "urn:li:geo:1", name: "India" },
    ]);
  });
});
