import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for Ads error toasts (task: real reason on failure):
 * the shared ApiError exposes the parsed body on `.data` (never `.payload`),
 * so error handlers must go through apiErrorMessage. This drives a draft
 * create through DraftDialog, fails it with a server-400-shaped ApiError,
 * and asserts the server's message reaches the toast description.
 */

// Radix menus/dialogs need a few APIs jsdom doesn't implement.
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

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListLinkedinCampaignGroups: () => ({
      data: { groups: [{ id: "grp_1", name: "Always On", status: "ACTIVE" }] },
      isLoading: false,
    }),
    getListLinkedinCampaignGroupsQueryKey: (params?: unknown) => [
      "/api/ads/linkedin/campaign-groups",
      params,
    ],
    useCreateAdDraft: () => ({ mutate: createDraftMutate, isPending: false }),
  });
});

// Imported after the mock so the mocked module is picked up.
import { DraftDialog } from "./ads";

// Mirrors the shared ApiError: parsed JSON body on `.data`, no `.payload`.
class FakeApiError extends Error {
  data: unknown;
  status: number;
  constructor(status: number, data: unknown) {
    super(`Request failed with status ${status}`);
    this.status = status;
    this.data = data;
  }
}

const CREATE_FORM = {
  action: "create" as "create" | "update",
  targetType: "campaign",
  targetId: null as string | null,
  currentName: "",
  name: "",
  status: "",
  dailyBudget: "",
  lifetimeBudget: "",
  startTime: "",
  stopTime: "",
  objective: "OUTCOME_TRAFFIC",
  bidAmount: "",
  bidStrategy: "",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("Ads draft create error toast", () => {
  it("shows the server 400 message in the toast description", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <DraftDialog
          connectionId={7}
          platform="linkedin"
          currency="USD"
          form={{ ...CREATE_FORM }}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "LI Launch" },
    });
    await user.click(screen.getByTestId("select-draft-campaign-group"));
    await user.click(await screen.findByText("Always On"));
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    const options = createDraftMutate.mock.calls[0]![1] as {
      onError: (err: unknown) => void;
    };
    options.onError(
      new FakeApiError(400, { error: "Daily budget is below the platform minimum." }),
    );

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: "Could not create the draft",
        description: "Daily budget is below the platform minimum.",
      }),
    );
  });
});
